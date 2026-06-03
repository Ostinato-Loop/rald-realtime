// RALD Realtime — Call Management Routes
// POST /calls/start — start a call in a room
// POST /calls/:id/end — end a call
// POST /calls/:id/record — start recording
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { Bindings, Variables } from "../types/env";
import type { ProductContext } from "../types/provider";
import { extractToken, verifyRaldToken, getClientIp } from "../lib/auth";
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from "../lib/rate-limit";
import { writeAuditLog, trackProviderUsage } from "../lib/audit";
import { withFailover } from "../lib/router";
import type { ProviderRegistry } from "../lib/router";

export function createCallsRouter(registry: ProviderRegistry) {
  const calls = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // POST /calls/start
  calls.post("/start", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const ip = getClientIp(c.req.raw);
    const rl = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.startCall(payload.id));
    if (!rl.allowed) {
      await writeAuditLog(c.env, { userId: payload.id, action: "rate_limited", ip, status: "blocked", metadata: { op: "start_call" } });
      return rateLimitResponse(rl.resetAt);
    }

    const body = await c.req.json().catch(() => null) as { roomId?: string; product?: ProductContext } | null;
    if (!body?.roomId || !body?.product)
      return c.json({ error: "roomId and product are required" }, 400);

    try {
      const result = await withFailover(registry, body.product, c.env, (p) =>
        p.startCall(body.roomId!), payload.id);

      await writeAuditLog(c.env, {
        userId: payload.id,
        action: "call_started",
        roomId: body.roomId,
        provider: result.provider,
        product: body.product,
        ip,
        status: "success",
      });
      await trackProviderUsage(c.env, { provider: result.provider, product: body.product, action: "call_start" });

      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: "Failed to start call", detail: String(err) }, 502);
    }
  });

  // POST /calls/:id/end
  calls.post("/:id/end", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const callId = c.req.param("id");
    const ip = getClientIp(c.req.raw);
    const body = await c.req.json().catch(() => ({})) as { product?: ProductContext; durationSeconds?: number };
    const product = body.product ?? "messenger";

    try {
      await withFailover(registry, product, c.env, (p) => p.endCall(callId), payload.id);

      await writeAuditLog(c.env, {
        userId: payload.id,
        action: "call_ended",
        roomId: callId,
        product,
        ip,
        status: "success",
        metadata: { durationSeconds: body.durationSeconds },
      });
      await trackProviderUsage(c.env, {
        provider: "realtimekit",
        product,
        action: "call_end",
        durationSeconds: body.durationSeconds,
      });

      return c.json({ ok: true, callId });
    } catch (err) {
      return c.json({ error: "Failed to end call", detail: String(err) }, 502);
    }
  });

  // POST /calls/:id/record
  calls.post("/:id/record", async (c) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);

    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    const roomId = c.req.param("id");
    const ip = getClientIp(c.req.raw);
    const body = await c.req.json().catch(() => ({})) as { product?: ProductContext };
    const product = body.product ?? "loop";

    try {
      const result = await withFailover(registry, product, c.env, (p) =>
        p.recordSession(roomId), payload.id);

      await writeAuditLog(c.env, {
        userId: payload.id,
        action: "recording_started",
        roomId,
        provider: result.provider,
        product,
        ip,
        status: "success",
      });

      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: "Failed to start recording", detail: String(err) }, 502);
    }
  });

  return calls;
}
