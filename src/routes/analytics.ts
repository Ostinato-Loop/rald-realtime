// RALD Realtime — Analytics + Cost Reporting Routes
// GET /analytics/summary — active rooms, calls, usage
// GET /analytics/costs — daily provider cost report
// GET /analytics/providers — provider usage breakdown
// Admin-only endpoints (role=admin|operator required).
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createClient } from "@supabase/supabase-js";
import type { Bindings, Variables } from "../types/env";
import { extractToken, verifyRaldToken } from "../lib/auth";

export function createAnalyticsRouter() {
  const analytics = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Admin auth middleware — typed as MiddlewareHandler to satisfy Hono v4 type constraints
  const adminOnly: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (c, next) => {
    const token = extractToken(c.req.header("Authorization"));
    if (!token) return c.json({ error: "Authorization required" }, 401);
    const payload = await verifyRaldToken(token, c.env.RALD_JWT_SECRET);
    if (!payload) return c.json({ error: "Invalid token" }, 401);
    if (!["admin", "operator"].includes(payload.role ?? ""))
      return c.json({ error: "Admin access required" }, 403);
    await next();
  };

  // GET /analytics/summary
  analytics.get("/summary", adminOnly, async (c) => {
    const db = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
    const since = new Date(Date.now() - 86400000).toISOString(); // last 24h

    const [auditData, usageData] = await Promise.allSettled([
      db.from("realtime_audit_log")
        .select("action, provider, product, status")
        .gte("created_at", since),
      db.from("realtime_provider_usage")
        .select("provider, product, action, duration_seconds, participant_count")
        .gte("recorded_at", since),
    ]);

    const audit = auditData.status === "fulfilled" ? (auditData.value.data ?? []) : [];
    const usage = usageData.status === "fulfilled" ? (usageData.value.data ?? []) : [];

    const roomsCreated = audit.filter((e: Record<string, string>) => e.action === "room_created").length;
    const roomsJoined = audit.filter((e: Record<string, string>) => e.action === "room_joined").length;
    const callsStarted = audit.filter((e: Record<string, string>) => e.action === "call_started").length;
    const failovers = audit.filter((e: Record<string, string>) => e.action === "provider_failover").length;
    const totalMinutes = usage.reduce((sum: number, u: Record<string, number>) => sum + ((u.duration_seconds ?? 0) / 60), 0);

    const providerBreakdown: Record<string, number> = {};
    audit.forEach((e: Record<string, string>) => {
      if (e.provider) providerBreakdown[e.provider] = (providerBreakdown[e.provider] ?? 0) + 1;
    });

    return c.json({
      period: "last_24h",
      rooms: { created: roomsCreated, joined: roomsJoined },
      calls: { started: callsStarted },
      failovers,
      totalMinutes: Math.round(totalMinutes),
      providerBreakdown,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /analytics/costs
  analytics.get("/costs", adminOnly, async (c) => {
    const db = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
    const today = new Date().toISOString().split("T")[0];

    const { data: usage } = await db
      .from("realtime_provider_usage")
      .select("provider, duration_seconds, participant_count")
      .gte("recorded_at", `${today}T00:00:00Z`);

    // Estimated costs (per-minute rates — operator should update)
    const COST_PER_MIN: Record<string, number> = {
      realtimekit: 0.00025, // CF Calls pricing
      livekit:     0.00100, // LiveKit Cloud
      tencent:     0.00080, // Tencent TRTC
    };

    const providerCosts: Record<string, { minutes: number; estimatedCostUSD: number }> = {};
    for (const row of (usage ?? [])) {
      const p = (row as Record<string, string>).provider;
      const mins = ((row as Record<string, number>).duration_seconds ?? 0) / 60;
      if (!providerCosts[p]) providerCosts[p] = { minutes: 0, estimatedCostUSD: 0 };
      providerCosts[p]!.minutes += mins;
      providerCosts[p]!.estimatedCostUSD += mins * (COST_PER_MIN[p] ?? 0);
    }

    // Round values
    Object.values(providerCosts).forEach((v) => {
      v.minutes = Math.round(v.minutes * 100) / 100;
      v.estimatedCostUSD = Math.round(v.estimatedCostUSD * 10000) / 10000;
    });

    const totalCost = Object.values(providerCosts).reduce((s, v) => s + v.estimatedCostUSD, 0);

    return c.json({
      date: today,
      providers: providerCosts,
      totalEstimatedCostUSD: Math.round(totalCost * 10000) / 10000,
      note: "Estimates only. Verify against provider dashboards.",
      timestamp: new Date().toISOString(),
    });
  });

  // GET /analytics/providers
  analytics.get("/providers", adminOnly, async (c) => {
    const db = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
    const since = new Date(Date.now() - 7 * 86400000).toISOString();

    const { data } = await db
      .from("realtime_audit_log")
      .select("provider, action, status, created_at")
      .gte("created_at", since)
      .not("provider", "is", null);

    const summary: Record<string, { success: number; failure: number; failover: number }> = {};
    for (const row of (data ?? [])) {
      const r = row as Record<string, string>;
      if (!r.provider) continue;
      if (!summary[r.provider]) summary[r.provider] = { success: 0, failure: 0, failover: 0 };
      if (r.action === "provider_failover") summary[r.provider]!.failover++;
      else if (r.status === "success") summary[r.provider]!.success++;
      else summary[r.provider]!.failure++;
    }

    return c.json({ period: "last_7d", providers: summary, timestamp: new Date().toISOString() });
  });

  return analytics;
}
