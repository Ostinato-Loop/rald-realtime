// RALD Realtime — Provider Router + Failover Engine
// Selects providers by product priority.
// Automatically retries on failure — applications never know a failover occurred.
// Audits every provider switch.
// LILCKY STUDIO LIMITED

import type { RealtimeProvider, ProviderName, ProductContext } from "../types/provider";
import { PROVIDER_PRIORITIES } from "../types/provider";
import type { Bindings } from "../types/env";
import { isProviderHealthy, storeProviderHealth } from "./health";
import { writeAuditLog } from "./audit";

export interface ProviderRegistry {
  realtimekit: RealtimeProvider;
  livekit: RealtimeProvider;
  tencent: RealtimeProvider;
}

export async function getProvider(
  registry: ProviderRegistry,
  product: ProductContext,
  env: Bindings,
  userId?: string
): Promise<RealtimeProvider> {
  const config = PROVIDER_PRIORITIES.find((p) => p.product === product)
    ?? PROVIDER_PRIORITIES[0]!;

  for (const providerName of config.priority) {
    const healthy = await isProviderHealthy(env.HEALTH_KV, providerName);
    if (healthy) {
      return registry[providerName];
    }
  }

  // All providers unhealthy — return first in priority anyway (fail-open)
  const fallback = registry[config.priority[0]!];
  await writeAuditLog(env, {
    userId,
    action: "provider_failover",
    provider: config.priority[0],
    product,
    status: "failure",
    metadata: { reason: "all_providers_unhealthy", product },
  });
  return fallback;
}

// ── Failover executor ─────────────────────────────────────────────────────────
// Wraps any provider operation with automatic failover.
// Applications call this wrapper and never interact with providers directly.

export async function withFailover<T>(
  registry: ProviderRegistry,
  product: ProductContext,
  env: Bindings,
  operation: (provider: RealtimeProvider) => Promise<T>,
  userId?: string
): Promise<T> {
  const config = PROVIDER_PRIORITIES.find((p) => p.product === product)
    ?? PROVIDER_PRIORITIES[0]!;

  let lastError: unknown;

  for (const providerName of config.priority) {
    const provider = registry[providerName];
    const health = await isProviderHealthy(env.HEALTH_KV, providerName);
    if (!health) continue;

    try {
      const result = await operation(provider);

      // Update health: success
      await storeProviderHealth(env.HEALTH_KV, {
        provider: providerName,
        healthy: true,
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
        consecutiveFailures: 0,
        lastSuccessAt: new Date().toISOString(),
      });

      return result;
    } catch (err) {
      lastError = err;
      console.warn(`[rald-realtime] provider ${providerName} failed:`, String(err));

      // Update health: failure
      const existing = await isProviderHealthy(env.HEALTH_KV, providerName);
      await storeProviderHealth(env.HEALTH_KV, {
        provider: providerName,
        healthy: false,
        latencyMs: -1,
        checkedAt: new Date().toISOString(),
        consecutiveFailures: existing ? 1 : 99,
        lastSuccessAt: null,
      });

      await writeAuditLog(env, {
        userId,
        action: "provider_switched",
        provider: providerName,
        product,
        status: "failure",
        metadata: { error: String(err), nextProvider: config.priority[config.priority.indexOf(providerName) + 1] ?? "none" },
      });
    }
  }

  throw new Error(
    `All realtime providers failed for product ${product}: ${String(lastError)}`
  );
}
