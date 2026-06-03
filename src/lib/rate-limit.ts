// RALD Realtime — KV Rate Limiting
// Sliding-window, consistent with rald-auth-core pattern.
// Fails open when KV is unavailable.
// LILCKY STUDIO LIMITED

import type { KVNamespace } from "../types/env";

export interface RateLimitConfig {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export async function checkRateLimit(
  kv: KVNamespace | undefined,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  if (!kv) {
    return { allowed: true, remaining: config.limit, resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds };
  }

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - config.windowSeconds;
  const kvKey = `rl:${config.key}`;

  let timestamps: number[] = [];
  try {
    const raw = await kv.get(kvKey);
    if (raw) timestamps = JSON.parse(raw) as number[];
  } catch { /* corrupt — start fresh */ }

  timestamps = timestamps.filter((t) => t > windowStart);
  const allowed = timestamps.length < config.limit;
  const remaining = Math.max(0, config.limit - timestamps.length - (allowed ? 1 : 0));
  const resetAt = timestamps.length > 0 ? timestamps[0]! + config.windowSeconds : now + config.windowSeconds;

  if (allowed) {
    timestamps.push(now);
    try {
      await kv.put(kvKey, JSON.stringify(timestamps), { expirationTtl: config.windowSeconds + 60 });
    } catch { /* non-fatal */ }
  }

  return { allowed, remaining, resetAt };
}

export const RATE_LIMITS = {
  createRoom: (userId: string): RateLimitConfig => ({
    key: `rt:create:${userId}`,
    limit: 10,
    windowSeconds: 3600,
  }),
  joinRoom: (userId: string): RateLimitConfig => ({
    key: `rt:join:${userId}`,
    limit: 30,
    windowSeconds: 3600,
  }),
  startCall: (userId: string): RateLimitConfig => ({
    key: `rt:call:${userId}`,
    limit: 20,
    windowSeconds: 3600,
  }),
  healthCheck: (ip: string): RateLimitConfig => ({
    key: `rt:health:${ip}`,
    limit: 60,
    windowSeconds: 60,
  }),
} as const;

export function rateLimitResponse(resetAt: number): Response {
  return Response.json(
    { error: "Too many requests. Please try again later." },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(0, resetAt - Math.floor(Date.now() / 1000))),
        "X-RateLimit-Reset": String(resetAt),
      },
    }
  );
}
