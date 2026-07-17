export interface QueueItem {
  id: string;
  position: number;
  url: string;
  title: string;
  artworkUrl: string | null;
  addedBy: string;
  createdAt: number;
  duration: number | null;
  available: boolean;
}

export interface PlaybackState {
  currentItemId: string | null;
  playing: boolean;
  anchorPosition: number;
  anchorTimestamp: number;
}

export interface RoomSnapshot {
  queue: QueueItem[];
  playback: PlaybackState;
  revision: number;
  serverTimestamp: number;
}

export interface CommandBase {
  commandId: string;
  revision: number;
}

export interface CommandAck {
  ok: boolean;
  revision: number;
  duplicate?: boolean;
  error?: RoomError;
}

export interface RoomError {
  code:
    | "INVALID_COMMAND"
    | "STALE_REVISION"
    | "QUEUE_FULL"
    | "INVALID_URL"
    | "TRACK_UNAVAILABLE"
    | "NOT_FOUND"
    | "INTERNAL_ERROR";
  message: string;
  commandId?: string;
}

export interface PresenceEntry { id: string; displayName: string; isHost: boolean }
export interface SessionInfo { isHost: boolean; pin: string | null }

export interface ClientToServerEvents {
  "queue:add": (payload: CommandBase & { url: string }, ack: (result: CommandAck) => void) => void;
  "queue:remove": (payload: CommandBase & { itemId: string }, ack: (result: CommandAck) => void) => void;
  "queue:move": (payload: CommandBase & { itemId: string; toIndex: number }, ack: (result: CommandAck) => void) => void;
  "playback:play": (payload: CommandBase & { position?: number }, ack: (result: CommandAck) => void) => void;
  "playback:pause": (payload: CommandBase & { position?: number }, ack: (result: CommandAck) => void) => void;
  "playback:seek": (payload: CommandBase & { position: number }, ack: (result: CommandAck) => void) => void;
  "playback:next": (payload: CommandBase, ack: (result: CommandAck) => void) => void;
  "playback:previous": (payload: CommandBase & { position?: number }, ack: (result: CommandAck) => void) => void;
  "track:duration": (payload: CommandBase & { itemId: string; duration: number }, ack: (result: CommandAck) => void) => void;
  "track:error": (payload: CommandBase & { itemId: string }, ack: (result: CommandAck) => void) => void;
  "track:finish": (payload: CommandBase & { itemId: string }, ack: (result: CommandAck) => void) => void;
  "sync:ping": (clientTimestamp: number, ack: (serverTimestamp: number, echoedClientTimestamp: number) => void) => void;
}

export interface ServerToClientEvents {
  "room:snapshot": (snapshot: RoomSnapshot) => void;
  "presence:update": (listeners: PresenceEntry[]) => void;
  "session:update": (session: SessionInfo) => void;
  "playback:sync": (snapshot: RoomSnapshot) => void;
  "room:error": (error: RoomError) => void;
}

export function expectedPosition(playback: PlaybackState, serverNow: number): number {
  if (!playback.playing) return playback.anchorPosition;
  return Math.max(0, playback.anchorPosition + serverNow - playback.anchorTimestamp);
}

export function shouldCorrectDrift(actual: number, expected: number, threshold = 1000): boolean {
  return Math.abs(actual - expected) > threshold;
}

export function toWidgetVolume(sliderPosition: number): number {
  const normalized = Math.max(0, Math.min(100, sliderPosition)) / 100;
  return Math.round(100 * normalized ** 2.4);
}

export interface ClockSample { offset: number; latency: number }

export function estimateClockOffset(samples: ClockSample[]): number {
  if (samples.length === 0) return 0;
  const best = [...samples].sort((a, b) => a.latency - b.latency).slice(0, Math.min(3, samples.length));
  return best.reduce((sum, sample) => sum + sample.offset, 0) / best.length;
}
