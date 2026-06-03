// RALD Realtime — Cloudflare Calls (RealtimeKit) Adapter
// Provider priority 1 for all RALD products.
// Cloudflare Calls API: https://developers.cloudflare.com/calls/
// LILCKY STUDIO LIMITED

import type {
  RealtimeProvider, ProviderName, RoomOptions, RoomResult,
  JoinResult, CallResult, Participant, RecordingResult, HealthResult, ProductContext
} from "../types/provider";

const CALLS_API = "https://rtc.live.cloudflare.com/v1";

export class RealtimeKitAdapter implements RealtimeProvider {
  readonly name: ProviderName = "realtimekit";

  constructor(
    private readonly appId: string,
    private readonly appSecret: string
  ) {}

  private get authHeader(): HeadersInit {
    return { Authorization: `Bearer ${this.appSecret}` };
  }

  async createRoom(opts: RoomOptions): Promise<RoomResult> {
    const res = await fetch(`${CALLS_API}/apps/${this.appId}/rooms`, {
      method: "POST",
      headers: { ...this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.roomId,
        metadata: JSON.stringify({ product: opts.product, hostId: opts.hostId, ...opts.metadata }),
        max_participants: opts.maxParticipants ?? 500,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RealtimeKit createRoom failed ${res.status}: ${err}`);
    }

    const data = await res.json() as { uid?: string; name?: string };
    return {
      roomId: opts.roomId,
      providerRoomId: data.uid ?? opts.roomId,
      provider: this.name,
      createdAt: new Date().toISOString(),
      metadata: opts.metadata,
    };
  }

  async joinRoom(
    roomId: string,
    userId: string,
    role = "listener",
    _product?: ProductContext
  ): Promise<JoinResult> {
    // Cloudflare Calls: create a session token for the participant
    const res = await fetch(`${CALLS_API}/apps/${this.appId}/sessions/new`, {
      method: "POST",
      headers: { ...this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionDescription: { type: "offer" } }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`RealtimeKit joinRoom failed ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as { sessionId?: string; sessionDescription?: { sdp?: string } };
    const token = btoa(JSON.stringify({ sessionId: data.sessionId, userId, roomId, role }));

    return {
      roomId,
      userId,
      provider: this.name,
      token,
      serverUrl: `wss://rtc.live.cloudflare.com/apps/${this.appId}`,
      providerRoomId: roomId,
    };
  }

  async leaveRoom(roomId: string, userId: string): Promise<void> {
    // Cloudflare Calls: close the session — best effort
    try {
      await fetch(`${CALLS_API}/apps/${this.appId}/sessions/${userId}`, {
        method: "DELETE",
        headers: this.authHeader,
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* non-fatal */ }
  }

  async startCall(roomId: string): Promise<CallResult> {
    return {
      callId: `cf-${roomId}-${Date.now()}`,
      roomId,
      provider: this.name,
      startedAt: new Date().toISOString(),
    };
  }

  async endCall(roomId: string): Promise<void> {
    try {
      await fetch(`${CALLS_API}/apps/${this.appId}/rooms/${roomId}`, {
        method: "DELETE",
        headers: this.authHeader,
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* non-fatal */ }
  }

  async publishAudio(_roomId: string, userId: string): Promise<{ trackId: string }> {
    return { trackId: `cf-audio-${userId}-${Date.now()}` };
  }

  async publishVideo(_roomId: string, userId: string): Promise<{ trackId: string }> {
    return { trackId: `cf-video-${userId}-${Date.now()}` };
  }

  async subscribeAudio(_roomId: string, userId: string): Promise<{ trackId: string; streamUrl?: string }> {
    return { trackId: `cf-audio-sub-${userId}` };
  }

  async subscribeVideo(_roomId: string, userId: string): Promise<{ trackId: string; streamUrl?: string }> {
    return { trackId: `cf-video-sub-${userId}` };
  }

  async recordSession(roomId: string): Promise<RecordingResult> {
    return {
      recordingId: `cf-rec-${roomId}-${Date.now()}`,
      roomId,
      provider: this.name,
      startedAt: new Date().toISOString(),
    };
  }

  async getParticipants(roomId: string): Promise<Participant[]> {
    try {
      const res = await fetch(`${CALLS_API}/apps/${this.appId}/rooms/${roomId}/sessions`, {
        headers: this.authHeader,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { sessions?: Array<{ sessionId: string; metadata?: string }> };
      return (data.sessions ?? []).map((s) => ({
        userId: s.sessionId,
        role: "listener" as const,
        joinedAt: new Date().toISOString(),
        audioEnabled: true,
        videoEnabled: false,
      }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<HealthResult> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${CALLS_API}/apps/${this.appId}`, {
        headers: this.authHeader,
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - t0;
      return {
        provider: this.name,
        healthy: res.ok,
        latencyMs,
        checkedAt: new Date().toISOString(),
        details: { status: res.status },
      };
    } catch (err) {
      return {
        provider: this.name,
        healthy: false,
        latencyMs: Date.now() - t0,
        checkedAt: new Date().toISOString(),
        details: { error: String(err) },
      };
    }
  }
}
