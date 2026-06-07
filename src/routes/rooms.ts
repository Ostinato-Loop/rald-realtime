// RALD Realtime — Room Management Routes
// GET  /rooms              — list live rooms (by product + optional region)
// GET  /rooms/:id          — get single room by ID
// POST /rooms              — create room
// POST /rooms/:id/join     — join room
// POST /rooms/:id/leave    — leave room
// GET  /rooms/:id/participants — list participants
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { Bindings, Variables } from "../types/env";
import type { ProductContext } from "../types/provider";
import { extractToken, verifyRaldToken, getClientIp } from "../lib/auth";
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from "../lib/rate-limit";
import { writeAuditLog } from "../lib/audit";
import { withFailover } from "../lib/router";
import type { ProviderRegistry } from "../lib/router";

// ── Room registry helpers (PROVIDER_STATE_KV) ─────────────────────────────────
// Key format: rooms:{product}:{roomId}
// Value: JSON blob with room metadata + participant count
// TTL: 24 hours (rooms auto-expire if not explicitly ended)

const ROOM_TTL_SECONDS = 86_400; // 24 hours

interface RoomRecord {
  roomId: string;
  product: string;
  name: string;
  description: string;
  host: string;
  hostId: string;
  category: string;
  region: string;
  language: string;
  participantCount: number;
  maxParticipants: number;
  createdAt: string;
  provider: string;
}

function roomKey(product: string, roomId: string): string {
  return `rooms:${product}:${roomId}`;
}

async function storeRoom(kv: Bindings["PROVIDER_STATE_KV"], record: RoomRecord): Promise<void> {
  await kv.put(roomKey(record.product, record.roomId), JSON.stringify(record), {
    expirationTtl: ROOM_TTL_SECONDS,
  });
}

async function removeRoom(kv: Bindings["PROVIDER_STATE_KV"], product: string, roomId: string): Promise<void> {
  await kv.delete(roomKey(product, roomId));
}

async function listRooms(
  kv: Bindings["PROVIDER_STATE_KV"],
  product: string,
  region?: string
): Promise<RoomRecord[]> {
  const prefix = `rooms:${product}:`;
  const rooms: RoomRecord[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
    const fetches = result.keys.map((k) => kv.get(k.name));
    const values = await Promise.all(fetches);

    for (const val of values) {
      if (!val) continue;
      try {
        const room = JSON.parse(val) as RoomRecord;
        if (!region || region === "all" || room.region === region) {
          rooms.push(room);
        }
      } catch { /* skip malformed */ }
    }

    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  // Sort: newest first
  rooms.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rooms;
}

export function createRoomsRouter(registry: ProviderRegistry) {
  const rooms = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // ── GET /rooms ──────────────────────────────────────────────────────────────
  rooms.get("/", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const product = (c.req.query("product") ?? "loop") as ProductContext;
    const region = c.req.query("region") ?? undefined;

    try {
      const roomList = await listRooms(c.env.PROVIDER_STATE_KV, product, region);
      return c.json({ rooms: roomList, count: roomList.length });
    } catch (err) {
      return c.json({ error: "Failed to list rooms", detail: String(err) }, 502);
    }
  });

  // ── GET /rooms/:id/participants ─────────────────────────────────────────────
  // Must be defined before GET /:id to avoid the :id wildcard swallowing "participants"
  rooms.get("/:id/participants", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const roomId = c.req.param("id");
    const product = (c.req.query("product") ?? "loop") as ProductContext;

    try {
      const participants = await withFailover(registry, product, c.env, (p) =>
        p.getParticipants(roomId), payload.id);
      return c.json({ roomId, participants, count: participants.length });
    } catch (err) {
      return c.json({ error: "Failed to get participants", detail: String(err) }, 502);
    }
  });

  // ── GET /rooms/:id ──────────────────────────────────────────────────────────
  rooms.get("/:id", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const roomId = c.req.param("id");
    const product = (c.req.query("product") ?? "loop") as ProductContext;

    const val = await c.env.PROVIDER_STATE_KV.get(roomKey(product, roomId));
    if (!val) return c.json({ error: "Room not found or has ended" }, 404);

    try {
      return c.json(JSON.parse(val) as RoomRecord);
    } catch {
      return c.json({ error: "Room data corrupted" }, 500);
    }
  });

  // ── POST /rooms ─────────────────────────────────────────────────────────────
  rooms.post("/", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const ip = getClientIp(c.req.raw);
    const rl = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.createRoom(payload.id));
    if (!rl.allowed) {
      await writeAuditLog(c.env, { userId: payload.id, action: "rate_limited", ip, status: "blocked", metadata: { op: "create_room" } });
      return rateLimitResponse(rl.resetAt);
    }

    const body = await c.req.json().catch(() => null) as {
      roomId?: string;
      product?: ProductContext;
      maxParticipants?: number;
      enableRecording?: boolean;
      enableVideo?: boolean;
      metadata?: Record<string, string>;
    } | null;

    if (!body?.roomId || !body?.product)
      return c.json({ error: "roomId and product are required" }, 400);

    try {
      const result = await withFailover(registry, body.product, c.env, (p) =>
        p.createRoom({
          roomId: body.roomId!,
          hostId: payload.id,
          product: body.product!,
          maxParticipants: body.maxParticipants,
          enableRecording: body.enableRecording,
          enableVideo: body.enableVideo,
          metadata: body.metadata,
        }), payload.id);

      // Store room in registry for GET /rooms and GET /rooms/:id
      const meta = body.metadata ?? {};
      const record: RoomRecord = {
        roomId: body.roomId,
        product: body.product,
        name: meta["name"] ?? body.roomId,
        description: meta["description"] ?? "",
        host: meta["host"] ?? payload.email ?? payload.id,
        hostId: payload.id,
        category: meta["category"] ?? "General",
        region: meta["region"] ?? "all",
        language: meta["language"] ?? "en",
        participantCount: 1,
        maxParticipants: body.maxParticipants ?? 500,
        createdAt: new Date().toISOString(),
        provider: result.provider,
      };
      await storeRoom(c.env.PROVIDER_STATE_KV, record);

      await writeAuditLog(c.env, {
        userId: payload.id,
        action: "room_created",
        roomId: body.roomId,
        provider: result.provider,
        product: body.product,
        ip,
        status: "success",
      });

      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: "Failed to create room", detail: String(err) }, 502);
    }
  });

  // ── POST /rooms/:id/join ────────────────────────────────────────────────────
  rooms.post("/:id/join", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const roomId = c.req.param("id");
    const ip = getClientIp(c.req.raw);

    const rl = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.joinRoom(payload.id));
    if (!rl.allowed) {
      await writeAuditLog(c.env, { userId: payload.id, action: "rate_limited", roomId, ip, status: "blocked", metadata: { op: "join_room" } });
      return rateLimitResponse(rl.resetAt);
    }

    const body = await c.req.json().catch(() => ({})) as { product?: ProductContext; role?: string };
    const product = body.product ?? "messenger";

    try {
      const result = await withFailover(registry, product, c.env, (p) =>
        p.joinRoom(roomId, payload.id, body.role ?? "listener", product), payload.id);

      // Increment participant count in registry
      const key = roomKey(product, roomId);
      const existing = await c.env.PROVIDER_STATE_KV.get(key);
      if (existing) {
        try {
          const rec = JSON.parse(existing) as RoomRecord;
          rec.participantCount = (rec.participantCount ?? 0) + 1;
          await storeRoom(c.env.PROVIDER_STATE_KV, rec);
        } catch { /* non-fatal */ }
      }

      await writeAuditLog(c.env, {
        userId: payload.id,
        action: "room_joined",
        roomId,
        provider: result.provider,
        product,
        ip,
        status: "success",
      });

      return c.json(result);
    } catch (err) {
      return c.json({ error: "Failed to join room", detail: String(err) }, 502);
    }
  });

  // ── POST /rooms/:id/leave ───────────────────────────────────────────────────
  rooms.post("/:id/leave", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const roomId = c.req.param("id");
    const ip = getClientIp(c.req.raw);
    const body = await c.req.json().catch(() => ({})) as { product?: ProductContext };
    const product = body.product ?? "messenger";

    try {
      await withFailover(registry, product, c.env, (p) =>
        p.leaveRoom(roomId, payload.id), payload.id);

      // Decrement participant count; remove room if host left or count hits zero
      const key = roomKey(product, roomId);
      const existing = await c.env.PROVIDER_STATE_KV.get(key);
      if (existing) {
        try {
          const rec = JSON.parse(existing) as RoomRecord;
          rec.participantCount = Math.max(0, (rec.participantCount ?? 1) - 1);
          if (rec.participantCount === 0 || payload.id === rec.hostId) {
            await removeRoom(c.env.PROVIDER_STATE_KV, product, roomId);
          } else {
            await storeRoom(c.env.PROVIDER_STATE_KV, rec);
          }
        } catch { /* non-fatal */ }
      }

      await writeAuditLog(c.env, {
        userId: payload.id,
        action: "room_left",
        roomId,
        product,
        ip,
        status: "success",
      });

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: "Failed to leave room", detail: String(err) }, 502);
    }
  });

  return rooms;
}
