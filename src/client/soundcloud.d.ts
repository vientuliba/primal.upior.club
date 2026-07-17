interface SoundCloudWidget {
  bind(event: string, listener: (event?: { currentPosition?: number }) => void): void;
  unbind(event: string): void;
  load(url: string, options: Record<string, unknown>): void;
  play(): void;
  pause(): void;
  seekTo(position: number): void;
  setVolume(volume: number): void;
  getDuration(callback: (duration: number) => void): void;
  getPosition(callback: (position: number) => void): void;
  isPaused(callback: (paused: boolean) => void): void;
}

interface SoundCloudWidgetFactory {
  (iframe: HTMLIFrameElement): SoundCloudWidget;
  Events: Record<"READY" | "PLAY" | "PAUSE" | "SEEK" | "FINISH" | "ERROR", string>;
}

interface Window {
  SC?: { Widget: SoundCloudWidgetFactory };
  __PRIMAL_ROOM_ACTIVE__?: boolean;
}
