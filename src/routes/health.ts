// RALD Realtime — Health + Provider Status Routes
// GET /health — worker health
// GET /health/providers — all provider health checks
// GET /health/providers/:name — specific provider health
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { Bindings, Variables } from "../types/env";
import type { ProviderName } from "../types/provider";
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from "../lib/rate-limit";
import { writeAuditLog } from "../lib/audit";
import { storeProviderHealth, getAllProviderHealth } from "../lib/health";
import { getClientIp } from "../lib/auth";
import type { ProviderRegistry } from "../lib/router";

const VERSION = "1.0.0";

export function createHealthRouter(registry: ProviderRegistry) {
  const health = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // GET /health — basic worker health
  health.get("/", (c) =>
    c.json({
      status: "ok",
      service: "rald-realtime",
      version: VERSION,
      environment: c.env.ENVIRONMENT ?? "production",
      owner: "LILCKY STUDIO LIMITED",
      timestamp: new Date().toISOString(),
    })
  );

  // GET /health/providers — live check all providers
  health.get("/providers", async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.healthCheck(ip));
    if (!rl.allowed) return rateLimitResponse(rl.resetAt);

    const providerNames: ProviderName[] = ["realtimekit", "livekit", "tencent"];

    const results = await Promise.allSettled(
      providerNames.map(async (name) => {
        const result = await registry[name].healthCheck();
        await storeProviderHealth(c.env.HEALTH_KV, result);
        return result;
      })
    );

    const checks = results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { provider: providerNames[i]!, healthy: false, latencyMs: -1, checkedAt: new Date().toISOString(), details: { error: String((r as PromiseRejectedResult).reason) } }
    );

    const allHealthy = checks.every((c) => c.healthy);

    await writeAuditLog(c.env, {
      action: "health_check",
      ip,
      status: "success",
      metadata: { results: checks.map((c) => ({ provider: c.provider, healthy: c.healthy, latencyMs: c.latencyMs })) },
    });

    return c.json({ ok: allHealthy, providers: checks, timestamp: new Date().toISOString() },
      allHealthy ? 200 : 207);
  });

  // GET /health/providers/:name — single provider health
  health.get("/providers/:name", async (c) => {
    const name = c.req.param("name") as ProviderName;
    if (!["realtimekit", "livekit", "tencent"].includes(name))
      return c.json({ error: "Unknown provider" }, 400);

    const ip = getClientIp(c.req.raw);
    const rl = await checkRateLimit(c.env.RATE_LIMIT_KV, RATE_LIMITS.healthCheck(ip));
    if (!rl.allowed) return rateLimitResponse(rl.resetAt);

    const result = await registry[name].healthCheck();
    await storeProviderHealth(c.env.HEALTH_KV, result);

    return c.json(result, result.healthy ? 200 : 503);
  });

  // GET /health/cached — return cached health without live ping
  health.get("/cached", async (c) => {
    const cached = await getAllProviderHealth(c.env.HEALTH_KV);
    return c.json({ providers: cached, timestamp: new Date().toISOString() });
  });

  return health;
}
