// RALD Realtime — Audit Logging
// Writes to Supabase realtime_audit_log (best-effort, never throws).
// LILCKY STUDIO LIMITED

import { createClient } from "@supabase/supabase-js";
import type { Bindings } from "../types/env";

export type RealtimeAuditAction =
  | "room_created"
  | "room_joined"
  | "room_left"
  | "room_ended"
  | "call_started"
  | "call_ended"
  | "provider_switched"
  | "provider_failover"
  | "rate_limited"
  | "auth_failed"
  | "health_check"
  | "recording_started"
  | "recording_stopped";

export interface AuditEntry {
  userId?: string | null;
  action: RealtimeAuditAction;
  roomId?: string;
  provider?: string;
  product?: string;
  ip?: string;
  status?: "success" | "failure" | "blocked";
  metadata?: Record<string, unknown>;
}

export async function writeAuditLog(env: Bindings, entry: AuditEntry): Promise<void> {
  try {
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    await db.from("realtime_audit_log").insert({
      user_id:   entry.userId ?? null,
      action:    entry.action,
      room_id:   entry.roomId ?? null,
      provider:  entry.provider ?? null,
      product:   entry.product ?? null,
      ip_address: entry.ip ?? null,
      status:    entry.status ?? "success",
      metadata:  entry.metadata ?? null,
    });
  } catch (err) {
    console.warn("[rald-realtime] audit write failed:", String(err));
  }
}

// ── Analytics: track provider usage + cost ──────────────────────────────────

export async function trackProviderUsage(
  env: Bindings,
  opts: {
    provider: string;
    product: string;
    action: string;
    durationSeconds?: number;
    participantCount?: number;
  }
): Promise<void> {
  try {
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    await db.from("realtime_provider_usage").insert({
      provider:          opts.provider,
      product:           opts.product,
      action:            opts.action,
      duration_seconds:  opts.durationSeconds ?? null,
      participant_count: opts.participantCount ?? null,
      recorded_at:       new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[rald-realtime] usage track failed:", String(err));
  }
}
