// RALD Realtime — LiveKit Adapter
// Provider priority 2 for Loop products.
// LiveKit Server SDK: https://docs.livekit.io/
// Generates access tokens using HMAC-SHA256.
// LILCKY STUDIO LIMITED

import type {
  RealtimeProvider, ProviderName, RoomOptions, RoomResult,
  JoinResult, CallResult, Participant, RecordingResult, HealthResult, ProductContext
} from "../types/provider";

export class LiveKitAdapter implements RealtimeProvider {
  readonly name: ProviderName = "livekit";

  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string
  ) {}

  // Generate a LiveKit access token (JWT)
  private async generateToken(
    roomName: string,
    participantIdentity: string,
    grants: Record<string, unknown>
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payload = btoa(JSON.stringify({
      iss: this.apiKey,
      exp: now + 3600,
      nbf: now,
      sub: participantIdentity,
      video: { room: roomName, roomJoin: true, ...grants },
    })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

    return `${header}.${payload}.${sigB64}`;
  }

  private get apiBaseUrl(): string {
    return this.serverUrl.replace(/^wss?:\/\//, "https://");
  }

  private get apiAuthHeader(): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiKey}:${this.apiSecret}`,
      "Content-Type": "application/json",
    };
  }

  async createRoom(opts: RoomOptions): Promise<RoomResult> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/twirp/livekit.RoomService/CreateRoom`, {
        method: "POST",
        headers: this.apiAuthHeader,
        body: JSON.stringify({
          name: opts.roomId,
          max_participants: opts.maxParticipants ?? 500,
          metadata: JSON.stringify({ product: opts.product, hostId: opts.hostId }),
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) throw new Error(`LiveKit createRoom ${res.status}: ${await res.text()}`);
      const data = await res.json() as { sid?: string };

      return {
        roomId: opts.roomId,
        providerRoomId: data.sid ?? opts.roomId,
        provider: this.name,
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      throw new Error(`LiveKit createRoom failed: ${String(err)}`);
    }
  }

  async joinRoom(
    roomId: string,
    userId: string,
    role = "listener",
    _product?: ProductContext
  ): Promise<JoinResult> {
    const grants = role === "host"
      ? { roomAdmin: true, canPublish: true, canSubscribe: true }
      : role === "speaker"
      ? { canPublish: true, canSubscribe: true }
      : { canPublish: false, canSubscribe: true };

    const token = await this.generateToken(roomId, userId, grants);

    return {
      roomId,
      userId,
      provider: this.name,
      token,
      serverUrl: this.serverUrl,
      providerRoomId: roomId,
    };
  }

  async leaveRoom(roomId: string, userId: string): Promise<void> {
    try {
      await fetch(`${this.apiBaseUrl}/twirp/livekit.RoomService/RemoveParticipant`, {
        method: "POST",
        headers: this.apiAuthHeader,
        body: JSON.stringify({ room: roomId, identity: userId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* non-fatal */ }
  }

  async startCall(roomId: string): Promise<CallResult> {
    return {
      callId: `lk-${roomId}-${Date.now()}`,
      roomId,
      provider: this.name,
      startedAt: new Date().toISOString(),
    };
  }

  async endCall(roomId: string): Promise<void> {
    try {
      await fetch(`${this.apiBaseUrl}/twirp/livekit.RoomService/DeleteRoom`, {
        method: "POST",
        headers: this.apiAuthHeader,
        body: JSON.stringify({ room: roomId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* non-fatal */ }
  }

  async publishAudio(_roomId: string, userId: string): Promise<{ trackId: string }> {
    return { trackId: `lk-audio-${userId}-${Date.now()}` };
  }

  async publishVideo(_roomId: string, userId: string): Promise<{ trackId: string }> {
    return { trackId: `lk-video-${userId}-${Date.now()}` };
  }

  async subscribeAudio(_roomId: string, userId: string): Promise<{ trackId: string }> {
    return { trackId: `lk-audio-sub-${userId}` };
  }

  async subscribeVideo(_roomId: string, userId: string): Promise<{ trackId: string }> {
    return { trackId: `lk-video-sub-${userId}` };
  }

  async recordSession(roomId: string): Promise<RecordingResult> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/twirp/livekit.EgressService/StartRoomCompositeEgress`, {
        method: "POST",
        headers: this.apiAuthHeader,
        body: JSON.stringify({ room_name: roomId, file_outputs: [{ filename: `${roomId}-${Date.now()}.mp4` }] }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json() as { egress_id?: string };
      return {
        recordingId: data.egress_id ?? `lk-rec-${roomId}`,
        roomId,
        provider: this.name,
        startedAt: new Date().toISOString(),
      };
    } catch {
      return {
        recordingId: `lk-rec-${roomId}-${Date.now()}`,
        roomId,
        provider: this.name,
        startedAt: new Date().toISOString(),
      };
    }
  }

  async getParticipants(roomId: string): Promise<Participant[]> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/twirp/livekit.RoomService/ListParticipants`, {
        method: "POST",
        headers: this.apiAuthHeader,
        body: JSON.stringify({ room: roomId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { participants?: Array<{ identity: string; joined_at: string; permission?: { can_publish?: boolean } }> };
      return (data.participants ?? []).map((p) => ({
        userId: p.identity,
        role: p.permission?.can_publish ? "speaker" as const : "listener" as const,
        joinedAt: p.joined_at,
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
      const res = await fetch(`${this.apiBaseUrl}/`, {
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - t0;
      return {
        provider: this.name,
        healthy: res.status < 500,
        latencyMs,
        checkedAt: new Date().toISOString(),
        details: { status: res.status, url: this.serverUrl },
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
