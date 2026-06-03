// RALD Realtime — Provider Health Monitor
// Tracks latency, availability, and outages per provider.
// Caches health state in KV with 30-second TTL.
// LILCKY STUDIO LIMITED

import type { KVNamespace } from "../types/env";
import type { HealthResult, ProviderName } from "../types/provider";

const HEALTH_TTL = 30; // seconds

export interface StoredHealth {
  provider: ProviderName;
  healthy: boolean;
  latencyMs: number;
  consecutiveFailures: number;
  lastCheckedAt: string;
  lastSuccessAt: string | null;
}

export async function getProviderHealth(
  kv: KVNamespace | undefined,
  provider: ProviderName
): Promise<StoredHealth | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(`health:${provider}`);
    return raw ? (JSON.parse(raw) as StoredHealth) : null;
  } catch {
    return null;
  }
}

export async function storeProviderHealth(
  kv: KVNamespace | undefined,
  result: HealthResult & { consecutiveFailures?: number; lastSuccessAt?: string | null }
): Promise<void> {
  if (!kv) return;
  try {
    const stored: StoredHealth = {
      provider: result.provider,
      healthy: result.healthy,
      latencyMs: result.latencyMs,
      consecutiveFailures: result.consecutiveFailures ?? 0,
      lastCheckedAt: result.checkedAt,
      lastSuccessAt: result.healthy ? result.checkedAt : (result.lastSuccessAt ?? null),
    };
    await kv.put(`health:${result.provider}`, JSON.stringify(stored), {
      expirationTtl: HEALTH_TTL * 4,
    });
  } catch { /* non-fatal */ }
}

export async function isProviderHealthy(
  kv: KVNamespace | undefined,
  provider: ProviderName
): Promise<boolean> {
  const stored = await getProviderHealth(kv, provider);
  if (!stored) return true; // optimistic if no data
  if (stored.consecutiveFailures >= 3) return false;
  return stored.healthy;
}

export async function getAllProviderHealth(
  kv: KVNamespace | undefined
): Promise<StoredHealth[]> {
  const providers: ProviderName[] = ["realtimekit", "livekit", "tencent"];
  const results = await Promise.all(providers.map((p) => getProviderHealth(kv, p)));
  return results.filter((r): r is StoredHealth => r !== null);
}
