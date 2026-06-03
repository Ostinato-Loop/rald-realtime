// RALD Realtime Abstraction Layer (RRAL)
// Deployed at: realtime.rald.cloud | Version: 1.0.0
// Phase G.10 — Provider-agnostic realtime platform for the RALD ecosystem.
// Providers: Cloudflare RealtimeKit (P1) → LiveKit (P2) → Tencent TRTC (P3)
// All apps communicate ONLY with realtime.rald.cloud.
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

const VERSION = "1.0.0";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use("*", cors({
  origin: [
    "https://rald.cloud", "https://app.rald.cloud", "https://loop.rald.cloud",
    "https://messenger.rald.cloud", "https://business.rald.cloud",
    "https://realtime.rald.cloud", "https://profiles.rald.cloud",
    "https://sv.rald.cloud", "http://localhost:5173", "http://localhost:3000",
  ],
  allowHeaders: ["Authorization", "Content-Type", "X-Product", "X-Request-ID"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  credentials: true,
}));

// ── Build provider registry (lazy — uses env secrets per request) ─────────────
function buildRegistry(env: Bindings): ProviderRegistry {
  return {
    realtimekit: new RealtimeKitAdapter(env.CALLS_APP_ID, env.CALLS_APP_SECRET),
    livekit:     new LiveKitAdapter(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET),
    tencent:     new TencentTRTCAdapter(env.TENCENT_SDK_APP_ID, env.TENCENT_SECRET_KEY),
  };
}

// ── Routes (registry built per-request to pick up env secrets) ───────────────
app.use("*", async (c, next) => {
  const registry = buildRegistry(c.env);

  // Mount routers by injecting registry
  const roomsApp  = createRoomsRouter(registry);
  const callsApp  = createCallsRouter(registry);
  const healthApp = createHealthRouter(registry);
  const analyticsApp = createAnalyticsRouter();

  // Delegate to correct sub-app
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/rooms"))     return roomsApp.fetch(c.req.raw, c.env, c.executionCtx);
  if (path.startsWith("/calls"))     return callsApp.fetch(c.req.raw, c.env, c.executionCtx);
  if (path.startsWith("/health"))    return healthApp.fetch(c.req.raw, c.env, c.executionCtx);
  if (path.startsWith("/analytics")) return analyticsApp.fetch(c.req.raw, c.env, c.executionCtx);

  await next();
});

// ── System status ─────────────────────────────────────────────────────────────
app.get("/status", (c) =>
  c.json({
    service:  "rald-realtime",
    version:  VERSION,
    phase:    "G.10",
    environment: c.env.ENVIRONMENT ?? "production",
    owner:    "LILCKY STUDIO LIMITED",
    providers: {
      realtimekit: !!c.env.CALLS_APP_ID && !!c.env.CALLS_APP_SECRET,
      livekit:     !!c.env.LIVEKIT_URL && !!c.env.LIVEKIT_API_KEY,
      tencent:     !!c.env.TENCENT_SDK_APP_ID && !!c.env.TENCENT_SECRET_KEY,
    },
    auth:     !!c.env.RALD_JWT_SECRET && !!c.env.RALD_AUTH_URL,
    timestamp: new Date().toISOString(),
  })
);

// ── Root ──────────────────────────────────────────────────────────────────────
app.get("/", (c) =>
  c.json({
    service:  "RALD Realtime Abstraction Layer",
    version:  VERSION,
    docs:     "https://realtime.rald.cloud/health",
    endpoints: {
      health:     "GET  /health",
      providers:  "GET  /health/providers",
      status:     "GET  /status",
      createRoom: "POST /rooms",
      joinRoom:   "POST /rooms/:id/join",
      leaveRoom:  "POST /rooms/:id/leave",
      participants:"GET /rooms/:id/participants",
      startCall:  "POST /calls/start",
      endCall:    "POST /calls/:id/end",
      record:     "POST /calls/:id/record",
      analytics:  "GET  /analytics/summary  (admin)",
      costs:      "GET  /analytics/costs    (admin)",
    },
    owner: "LILCKY STUDIO LIMITED",
    timestamp: new Date().toISOString(),
  })
);

app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("[rald-realtime]", err.message ?? err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
