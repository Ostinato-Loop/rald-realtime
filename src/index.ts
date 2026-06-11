// RALD Realtime Abstraction Layer (RRAL)
// Deployed at: realtime.rald.cloud | Version: 1.1.0
// Phase G.10 — Provider-agnostic realtime platform for the RALD ecosystem.
// Providers: Cloudflare RealtimeKit (P1) → LiveKit (P2) → Tencent TRTC (P3)
// All apps communicate ONLY with realtime.rald.cloud.
// FIX-001 (2026-06-10): CORS — add messenger.ostloop.name.ng (live prod domain).
// FIX-002 (2026-06-10): Accept TENCENT_SDKAPPID / TENCENT_SECRETKEY naming aliases.
// OBS-001 (2026-06-10): OpenObserve structured request logging via ctx.waitUntil.
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Bindings, Variables } from "./types/env";
import { RealtimeKitAdapter } from "./providers/realtimekit";
import { LiveKitAdapter } from "./providers/livekit";
import { TencentTRTCAdapter } from "./providers/tencent";
import { createRoomsRouter } from "./routes/rooms";
import { createCallsRouter } from "./routes/calls";
import { createHealthRouter } from "./routes/health";
import { createAnalyticsRouter } from "./routes/analytics";
import type { ProviderRegistry } from "./lib/router";

const VERSION = "1.1.0";

// ── OpenObserve structured logger ─────────────────────────────────────────────
async function logToOpenObserve(
  env: Bindings & { OPEN_OBSERVE_API_KEY?: string; OPEN_OBSERVE_ENDPOINT?: string },
  record: Record<string, unknown>,
): Promise<void> {
  const key = env.OPEN_OBSERVE_API_KEY;
  const endpoint = env.OPEN_OBSERVE_ENDPOINT;
  if (!key || !endpoint) return;
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${btoa(`root@example.com:${key}`)}`,
      },
      body: JSON.stringify([{ _timestamp: Date.now() * 1000, service: "rald-realtime", ...record }]),
    });
  } catch { /* non-blocking */ }
}

const ALLOWED_ORIGINS = new Set([
  "https://rald.cloud",
  "https://app.rald.cloud",
  "https://loop.rald.cloud",
  "https://messenger.rald.cloud",
  // FIX-001: live production messenger domain
  "https://messenger.ostloop.name.ng",
  "https://business.rald.cloud",
  "https://realtime.rald.cloud",
  "https://profiles.rald.cloud",
  "https://sv.rald.cloud",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:23226",
]);

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.replit\.(app|dev)$/.test(origin)) return true;
  return false;
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("*", cors({
  origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
  allowHeaders: ["Authorization", "Content-Type", "X-Product", "X-Request-ID"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  credentials: true,
}));

// ── FIX-002: resolve provider credentials with naming alias support ────────────
function resolveEnv(env: Bindings) {
  const e = env as Bindings & Record<string, string>;
  return {
    // Tencent: accept both TENCENT_SDK_APP_ID and TENCENT_SDKAPPID
    tencentSdkAppId: e.TENCENT_SDK_APP_ID || e["TENCENT_SDKAPPID"] || "",
    tencentSecretKey: e.TENCENT_SECRET_KEY || e["TENCENT_SECRETKEY"] || "",
    // Cloudflare RealtimeKit
    callsAppId: e.CALLS_APP_ID || "",
    callsAppSecret: e.CALLS_APP_SECRET || "",
    // LiveKit
    livekitUrl: e.LIVEKIT_URL || "",
    livekitApiKey: e.LIVEKIT_API_KEY || "",
    livekitApiSecret: e.LIVEKIT_API_SECRET || "",
  };
}

function buildRegistry(env: Bindings): ProviderRegistry {
  const r = resolveEnv(env);
  return {
    realtimekit: new RealtimeKitAdapter(r.callsAppId, r.callsAppSecret),
    livekit:     new LiveKitAdapter(r.livekitUrl, r.livekitApiKey, r.livekitApiSecret),
    tencent:     new TencentTRTCAdapter(r.tencentSdkAppId, r.tencentSecretKey),
  };
}

app.use("*", async (c, next) => {
  const registry = buildRegistry(c.env);
  const roomsApp     = createRoomsRouter(registry);
  const callsApp     = createCallsRouter(registry);
  const healthApp    = createHealthRouter(registry);
  const analyticsApp = createAnalyticsRouter();

  const path = new URL(c.req.url).pathname;
  // Strip path prefix so sub-app Hono routers receive "/" not "/health" etc.
  const rewrite = (pfx: string) => { const u = new URL(c.req.url); u.pathname = path.slice(pfx.length) || "/"; return new Request(u.toString(), c.req.raw); };
  if (path.startsWith("/rooms"))     return roomsApp.fetch(rewrite("/rooms"), c.env, c.executionCtx);
  if (path.startsWith("/calls"))     return callsApp.fetch(rewrite("/calls"), c.env, c.executionCtx);
  if (path.startsWith("/health"))    return healthApp.fetch(rewrite("/health"), c.env, c.executionCtx);
  if (path.startsWith("/analytics")) return analyticsApp.fetch(rewrite("/analytics"), c.env, c.executionCtx);
  await next();
});

app.get("/status", (c) => {
  const r = resolveEnv(c.env);
  return c.json({
    service: "rald-realtime", version: VERSION, phase: "G.10",
    environment: c.env.ENVIRONMENT ?? "production",
    owner: "LILCKY STUDIO LIMITED",
    providers: {
      realtimekit: !!r.callsAppId && !!r.callsAppSecret,
      livekit:     !!r.livekitUrl && !!r.livekitApiKey,
      tencent:     !!r.tencentSdkAppId && !!r.tencentSecretKey,
    },
    auth:      !!c.env.RALD_JWT_SECRET && !!c.env.RALD_AUTH_URL,
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (c) =>
  c.json({
    service: "RALD Realtime Abstraction Layer", version: VERSION,
    docs: "https://realtime.rald.cloud/health",
    endpoints: {
      health: "GET /health", providers: "GET /health/providers", status: "GET /status",
      listRooms: "GET /rooms?product=loop&region=lagos", createRoom: "POST /rooms",
      joinRoom: "POST /rooms/:id/join", leaveRoom: "POST /rooms/:id/leave",
      participants: "GET /rooms/:id/participants", startCall: "POST /calls/start",
      endCall: "POST /calls/:id/end", record: "POST /calls/:id/record",
      analytics: "GET /analytics/summary (admin)", costs: "GET /analytics/costs (admin)",
    },
    owner: "LILCKY STUDIO LIMITED", timestamp: new Date().toISOString(),
  })
);

app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("[rald-realtime]", err.message ?? err);
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  async fetch(req: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const start = Date.now();
    const r = resolveEnv(env);

    // FIX-002: check resolved aliases — one provider is enough to operate
    if (!r.callsAppSecret && !r.livekitApiSecret && !r.tencentSecretKey) {
      const msg = "CALLS_APP_SECRET or LIVEKIT_API_SECRET or TENCENT_SECRET_KEY (at least one provider)";
      console.error(`[FATAL] rald-realtime: missing required config: ${msg}`);
      return new Response(
        JSON.stringify({ error: "Service misconfigured", missing: [msg], service: "rald-realtime" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    const res = await app.fetch(req, env, ctx);

    // OBS-001: fire-and-forget structured log to OpenObserve
    const url = new URL(req.url);
    ctx.waitUntil(logToOpenObserve(env as Bindings & { OPEN_OBSERVE_API_KEY?: string; OPEN_OBSERVE_ENDPOINT?: string }, {
      method: req.method,
      path: url.pathname,
      status: res.status,
      latency_ms: Date.now() - start,
      cf_ray: req.headers.get("cf-ray") ?? "",
      environment: env.ENVIRONMENT ?? "production",
    }));

    return res;
  },

  // ── Scheduled: Ghost room cleanup (runs every 15 min via cron) ────────────
  // Phase 4: Room Reliability — remove rooms with 0 participants > 1h old
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const kv = env.PROVIDER_STATE_KV;
        const products = ["loop", "messenger", "payrald", "voice", "dispatch"];
        const ghostThresholdMs = 3_600_000; // 1 hour with 0 participants = ghost room

        let total = 0;
        let removed = 0;

        for (const product of products) {
          const prefix = `rooms:${product}:`;
          let cursor: string | undefined;

          do {
            const result = await kv.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
            total += result.keys.length;

            for (const key of result.keys) {
              const val = await kv.get(key.name);
              if (!val) { removed++; continue; }
              try {
                const room = JSON.parse(val) as {
                  participantCount?: number;
                  createdAt?: string;
                  roomId?: string;
                };
                const age = Date.now() - new Date(room.createdAt ?? 0).getTime();
                const isGhost = (room.participantCount ?? 0) === 0 && age > ghostThresholdMs;
                if (isGhost) {
                  await kv.delete(key.name);
                  removed++;
                  console.log(`[cleanup] ghost room removed: ${key.name} (age=${Math.round(age / 60_000)}min)`);
                }
              } catch {
                // Malformed record — remove it
                await kv.delete(key.name);
                removed++;
              }
            }

            cursor = result.list_complete ? undefined : result.cursor;
          } while (cursor);
        }

        console.log(`[cleanup] done — scanned ${total}, removed ${removed} ghost rooms`);
      } catch (err) {
        console.error("[scheduled] ghost room cleanup failed:", String(err));
      }
    })());
  },
};
