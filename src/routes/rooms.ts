// RALD Realtime — Room Management Routes
// POST /rooms — create room
// POST /rooms/:id/join — join room
// POST /rooms/:id/leave — leave room
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

export function createRoomsRouter(registry: ProviderRegistry) {
  const rooms = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // POST /rooms
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

  // POST /rooms/:id/join
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

  // POST /rooms/:id/leave
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

  // GET /rooms/:id/participants
  rooms.get("/:id/participants", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const roomId = c.req.param("id");
    const product = (c.req.query("product") ?? "messenger") as ProductContext;

    try {
      const participants = await withFailover(registry, product, c.env, (p) =>
        p.getParticipants(roomId), payload.id);
      return c.json({ roomId, participants, count: participants.length });
    } catch (err) {
      return c.json({ error: "Failed to get participants", detail: String(err) }, 502);
    }
  });

  return rooms;
}
