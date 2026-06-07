// RALD Realtime — Cloudflare Worker Bindings
// LILCKY STUDIO LIMITED

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export type Bindings = {
  // RALD Identity
  RALD_JWT_SECRET: string;
  RALD_AUTH_URL: string;

  // Cloudflare Calls / RealtimeKit
  CALLS_APP_ID: string;
  CALLS_APP_SECRET: string;

  // LiveKit
  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;

  // Tencent TRTC
  TENCENT_SDK_APP_ID: string;
  TENCENT_SECRET_KEY: string;

  // Supabase (for audit/analytics persistence)
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Environment
  ENVIRONMENT: string;

  // KV Namespaces
  RATE_LIMIT_KV: KVNamespace;
  HEALTH_KV: KVNamespace;
  PROVIDER_STATE_KV: KVNamespace;
};

export type Variables = {
  userId?: string;
  product?: string;
};
