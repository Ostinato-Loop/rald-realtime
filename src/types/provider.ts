// RALD Realtime Abstraction Layer — Provider Interface
// Every adapter must implement this exact interface.
// Applications interact only with this interface — never with providers directly.
// LILCKY STUDIO LIMITED

export type ProviderName = "realtimekit" | "livekit" | "tencent";
export type ProductContext = "loop" | "messenger" | "loop-voice" | "loop-business" | "payrald";

export interface RoomOptions {
  roomId: string;
  hostId: string;
  product: ProductContext;
  maxParticipants?: number;
  enableRecording?: boolean;
  enableVideo?: boolean;
  metadata?: Record<string, string>;
}

export interface RoomResult {
  roomId: string;
  providerRoomId: string;
  provider: ProviderName;
  createdAt: string;
  metadata?: Record<string, string>;
}

export interface JoinResult {
  roomId: string;
  userId: string;
  provider: ProviderName;
  token: string;
  serverUrl: string;
  providerRoomId: string;
}

export interface CallResult {
  callId: string;
  roomId: string;
  provider: ProviderName;
  startedAt: string;
}

export interface Participant {
  userId: string;
  role: "host" | "moderator" | "speaker" | "listener";
  joinedAt: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
}

export interface RecordingResult {
  recordingId: string;
  roomId: string;
  provider: ProviderName;
  startedAt: string;
  storageUrl?: string;
}

export interface HealthResult {
  provider: ProviderName;
  healthy: boolean;
  latencyMs: number;
  checkedAt: string;
  details?: Record<string, unknown>;
}

// ── The canonical provider interface ─────────────────────────────────────────
// Every adapter MUST implement all methods.

export interface RealtimeProvider {
  readonly name: ProviderName;

  createRoom(opts: RoomOptions): Promise<RoomResult>;
  joinRoom(roomId: string, userId: string, role?: string, product?: ProductContext): Promise<JoinResult>;
  leaveRoom(roomId: string, userId: string): Promise<void>;
  startCall(roomId: string): Promise<CallResult>;
  endCall(roomId: string): Promise<void>;
  publishAudio(roomId: string, userId: string): Promise<{ trackId: string }>;
  publishVideo(roomId: string, userId: string): Promise<{ trackId: string }>;
  subscribeAudio(roomId: string, userId: string): Promise<{ trackId: string; streamUrl?: string }>;
  subscribeVideo(roomId: string, userId: string): Promise<{ trackId: string; streamUrl?: string }>;
  recordSession(roomId: string): Promise<RecordingResult>;
  getParticipants(roomId: string): Promise<Participant[]>;
  healthCheck(): Promise<HealthResult>;
}

// ── Provider routing config ────────────────────────────────────────────────
// NOTE: Loop uses livekit as P1 because the Loop client uses livekit-client
// (WebRTC SDK). Cloudflare Calls (realtimekit) tokens are not compatible
// with the LiveKit signaling protocol — do not swap these back.

export interface ProviderPriority {
  product: ProductContext;
  priority: ProviderName[];
  degradedMode?: "audio-only" | "voice-note-only";
}

export const PROVIDER_PRIORITIES: ProviderPriority[] = [
  {
    product: "loop",
    priority: ["livekit", "realtimekit"],   // livekit MUST be P1 for loop
    degradedMode: "audio-only",
  },
  {
    product: "loop-voice",
    priority: ["livekit", "realtimekit"],
    degradedMode: "audio-only",
  },
  {
    product: "loop-business",
    priority: ["livekit", "realtimekit"],
    degradedMode: "audio-only",
  },
  {
    product: "messenger",
    priority: ["realtimekit", "tencent"],
    degradedMode: "voice-note-only",
  },
  {
    product: "payrald",
    priority: ["realtimekit", "livekit"],
    degradedMode: "audio-only",
  },
];
