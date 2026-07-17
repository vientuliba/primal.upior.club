import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertCircle, Check, ChevronDown, ChevronUp, CirclePlus, Copy, Crown, GripVertical, Headphones, Link2, ListMusic, LoaderCircle, LogOut, Pause, Play, RotateCcw, SkipBack, SkipForward, Trash2, Users, Volume1, Volume2 } from "lucide-react";
import type { ClientToServerEvents, CommandAck, PresenceEntry, QueueItem, RoomSnapshot, ServerToClientEvents, SessionInfo } from "../shared/protocol";
import { estimateClockOffset, expectedPosition, shouldCorrectDrift, toWidgetVolume, type ClockSample } from "../shared/protocol";

type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

const blankSnapshot: RoomSnapshot = {
  queue: [], playback: { currentItemId: null, playing: false, anchorPosition: 0, anchorTimestamp: 0 }, revision: 0, serverTimestamp: 0,
};

export function App() {
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [roomActive, setRoomActive] = useState<boolean | null>(null);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("primal:name") ?? "");
  const [pin, setPin] = useState(() => {
    const saved = localStorage.getItem("primal:pin") ?? "";
    return /^\d{6}$/.test(saved) ? saved : "";
  });
  const [snapshot, setSnapshot] = useState<RoomSnapshot>(blankSnapshot);
  const [listeners, setListeners] = useState<PresenceEntry[]>([]);
  const [session, setSession] = useState<SessionInfo>({ isHost: false, pin: null });
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [trackUrl, setTrackUrl] = useState("");
  const [volume, setVolume] = useState(() => Number(localStorage.getItem("primal:volume-slider") ?? localStorage.getItem("primal:volume") ?? 55));
  const [clockOffset, setClockOffset] = useState(0);
  const socketRef = useRef<RoomSocket | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => () => { socketRef.current?.disconnect(); }, []);

  const refreshRoomStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const status = await response.json() as { active: boolean };
      setRoomActive(status.active);
    } catch {
      setRoomActive(null);
    }
  }, []);

  useEffect(() => {
    if (joined) return;
    void refreshRoomStatus();
    const timer = window.setInterval(() => void refreshRoomStatus(), 3_000);
    return () => window.clearInterval(timer);
  }, [joined, refreshRoomStatus]);

  const connect = (event: React.FormEvent) => {
    event.preventDefault();
    if (joining) return;
    const cleanName = displayName.trim();
    if (!cleanName) { setError("Enter a display name."); return; }
    if (roomActive === null) { setError("Still checking the room. Try again in a moment."); return; }
    const creating = !roomActive;
    const roomPin = creating ? generatePin() : pin;
    if (!/^\d{6}$/.test(roomPin)) { setError("Enter the six-digit room PIN."); return; }
    localStorage.setItem("primal:name", cleanName);
    if (creating) void navigator.clipboard.writeText(roomPin).catch(() => undefined);
    setDisplayName(cleanName);
    setPin(roomPin);
    setJoining(true);
    setConnection("connecting");
    setError(null);
    let connectedOnce = false;
    const socket: RoomSocket = io({ auth: { displayName: cleanName, pin: roomPin, createRoom: creating }, reconnection: true });
    socketRef.current = socket;
    socket.on("connect", () => {
      connectedOnce = true;
      socket.auth = { displayName: cleanName, pin: roomPin, createRoom: false };
      localStorage.setItem("primal:pin", roomPin);
      setJoining(false);
      setJoined(true);
      setRoomActive(true);
      setConnection("connected");
      void calibrateClock(socket, setClockOffset);
    });
    socket.io.on("reconnect_attempt", () => setConnection("reconnecting"));
    socket.on("disconnect", () => setConnection("reconnecting"));
    socket.on("connect_error", (cause) => {
      setJoining(false);
      setConnection("offline");
      setError(cause.message);
      if (!connectedOnce) {
        socket.disconnect();
        socketRef.current = null;
        setJoined(false);
        void refreshRoomStatus();
      }
    });
    socket.on("room:snapshot", setSnapshot);
    socket.on("playback:sync", (next) => setSnapshot((current) => next.revision >= current.revision ? next : current));
    socket.on("presence:update", setListeners);
    socket.on("session:update", (nextSession) => {
      setSession(nextSession);
      if (nextSession.pin) {
        setPin(nextSession.pin);
        localStorage.setItem("primal:pin", nextSession.pin);
        socket.auth = { displayName: cleanName, pin: nextSession.pin, createRoom: false };
      }
    });
    socket.on("room:error", (roomError) => setError(roomError.message));
  };

  const leave = () => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setJoining(false);
    setJoined(false);
    setConnection("offline");
    setListeners([]);
    setSession({ isHost: false, pin: null });
  };

  const command = useCallback((event: keyof ClientToServerEvents, extra: Record<string, unknown> = {}, onDone?: (ack: CommandAck) => void) => {
    const socket = socketRef.current;
    if (!socket?.connected) { setError("You’re offline. Reconnect before changing the room."); return; }
    const payload = { commandId: crypto.randomUUID(), revision: snapshotRef.current.revision, ...extra };
    const ack = (result: CommandAck) => {
      if (!result.ok && result.error?.code !== "STALE_REVISION") setError(result.error?.message ?? "The command failed.");
      onDone?.(result);
    };
    // Socket.IO's union of overloaded event signatures cannot infer a dynamic event key.
    (socket.emit as (name: string, payload: unknown, ack: (result: CommandAck) => void) => RoomSocket)(event, payload, ack);
  }, []);

  const addTrack = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trackUrl.trim()) return;
    setAdding(true);
    setError(null);
    command("queue:add", { url: trackUrl.trim() }, (ack) => {
      setAdding(false);
      if (ack.ok) setTrackUrl("");
    });
  };

  const changeVolume = (next: number) => {
    setVolume(next);
    localStorage.setItem("primal:volume-slider", String(next));
  };

  if (!joined) return <>
    <JoinScreen displayName={displayName} pin={pin} roomActive={roomActive} joining={joining} error={error} setDisplayName={setDisplayName} setPin={setPin} onJoin={connect} />
    <HomeReturn />
  </>;

  return <>
    <Room
      snapshot={snapshot} listeners={listeners} session={session} connection={connection} error={error} trackUrl={trackUrl} adding={adding}
      volume={volume} clockOffset={clockOffset} iframeKey={joined ? "joined" : "left"}
      setTrackUrl={setTrackUrl} setError={setError} onAdd={addTrack} onLeave={leave} onVolume={changeVolume} command={command}
    />
    <HomeReturn />
  </>;
}

function HomeReturn() {
  return <a className="home-return" href="https://upior.club" aria-label="Return to upior.club">← upior.club</a>;
}

function JoinScreen(props: { displayName: string; pin: string; roomActive: boolean | null; joining: boolean; error: string | null; setDisplayName: (value: string) => void; setPin: (value: string) => void; onJoin: (event: React.FormEvent) => void }) {
  return <main className="join-shell">
    <div className="join-glow" />
    <section className="join-card">
      <div className="brand-mark"><span /><span /><span /><span /></div>
      <p className="eyebrow">shared listening room</p>
      <h1>primal</h1>
      <p className="join-copy">one soundcloud queue, synchronized for everyone connected.</p>
      <div className={`room-status ${props.roomActive === false ? "empty" : "active"}`}>
        <i />
        {props.roomActive === null ? "Checking the room…" : props.roomActive ? "A room is active — enter its PIN to join." : "The room is empty — you’ll become host."}
      </div>
      <form onSubmit={props.onJoin} className="join-form">
        <label>DISPLAY NAME<input autoFocus maxLength={32} autoComplete="nickname" value={props.displayName} onChange={(event) => props.setDisplayName(event.target.value)} placeholder="What should friends call you?" /></label>
        {props.roomActive && <label>ROOM PIN<input maxLength={6} inputMode="numeric" autoComplete="one-time-code" value={props.pin} onChange={(event) => props.setPin(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 digits" type="password" /></label>}
        {props.error && <div className="inline-error"><AlertCircle size={16} />{props.error}</div>}
        <button className="primary join-button" type="submit" disabled={props.roomActive === null || props.joining}>
          {props.joining ? <LoaderCircle className="spin" size={19} /> : <Headphones size={19} />}
          {props.joining ? "Checking PIN…" : props.roomActive === false ? "Create room & copy PIN" : "Enter the room"}
        </button>
      </form>
      <p className="fine-print">{props.roomActive === false ? "A six-digit PIN will be generated, copied, and shown inside the room." : "Your name, PIN, and volume stay in this browser."}</p>
    </section>
  </main>;
}

interface RoomProps {
  snapshot: RoomSnapshot; listeners: PresenceEntry[]; session: SessionInfo; connection: ConnectionState; error: string | null;
  trackUrl: string; adding: boolean; volume: number; clockOffset: number; iframeKey: string;
  setTrackUrl: (value: string) => void; setError: (value: string | null) => void;
  onAdd: (event: React.FormEvent) => void; onLeave: () => void; onVolume: (value: number) => void;
  command: (event: keyof ClientToServerEvents, extra?: Record<string, unknown>, onDone?: (ack: CommandAck) => void) => void;
}

function Room(props: RoomProps) {
  const current = props.snapshot.queue.find((item) => item.id === props.snapshot.playback.currentItemId) ?? null;
  const lastWidgetUrl = useRef<string | null>(null);
  if (current) lastWidgetUrl.current = current.url;
  const widgetUrl = lastWidgetUrl.current;
  const [copiedPin, setCopiedPin] = useState(false);
  const widget = useSoundCloudWidget(current, props.snapshot, props.clockOffset, props.volume, props.command);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const dragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = props.snapshot.queue.findIndex((item) => item.id === active.id);
    const to = props.snapshot.queue.findIndex((item) => item.id === over.id);
    const reordered = arrayMove(props.snapshot.queue, from, to);
    props.command("queue:move", { itemId: active.id, toIndex: reordered.findIndex((item) => item.id === active.id) });
  };

  const sendWithWidgetPosition = (event: "playback:play" | "playback:pause" | "playback:previous") => {
    widget.getPosition((actual) => props.command(event, { position: actual }));
  };

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark small"><span /><span /><span /><span /></div><strong>PRIMAL</strong><span className="room-label">LISTEN-ALONG</span></div>
      <div className="top-actions">
        {props.session.isHost && props.session.pin && <button className="host-pin" onClick={() => { void navigator.clipboard.writeText(props.session.pin!); setCopiedPin(true); setTimeout(() => setCopiedPin(false), 1500); }} title="Copy room PIN"><Crown size={14} /><span>PIN <b>{props.session.pin}</b></span>{copiedPin ? <Check size={14} /> : <Copy size={14} />}</button>}
        <span className={`connection ${props.connection}`}><i />{connectionLabel(props.connection)}</span><button className="icon-button" onClick={props.onLeave} title="Leave room"><LogOut size={18} /></button>
      </div>
    </header>

    {props.error && <div className="toast" role="alert"><AlertCircle size={17} /><span>{props.error}</span><button onClick={() => props.setError(null)}>×</button></div>}

    <div className="room-grid">
      <section className="player-panel">
        <div className="now-label"><span /> NOW PLAYING</div>
        <div className="track-hero">
          <div className="artwork">{current?.artworkUrl ? <img src={current.artworkUrl} alt="" /> : <div className="art-placeholder"><ListMusic /></div>}<div className={`playing-bars ${props.snapshot.playback.playing ? "active" : ""}`}><i /><i /><i /><i /></div></div>
          <div className="track-heading">
            <h1>{current?.title ?? "The room is quiet"}</h1>
            {current ? <a href={current.url} target="_blank" rel="noreferrer"><Link2 size={14} /> Open original on SoundCloud</a> : <p>Add a SoundCloud track to begin.</p>}
          </div>
        </div>

        <div className="official-widget">
          {widgetUrl && <iframe className={current ? "" : "widget-hidden"} key={props.iframeKey} ref={widget.iframeRef} title="Official SoundCloud player" allow="autoplay" scrolling="no" src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(widgetUrl)}&show_user=true&show_artwork=false&show_comments=false&auto_play=false&color=%23ff5a1f`} />}
          {!current && <div className="widget-empty">The official SoundCloud player will appear here.</div>}
        </div>

        <div className="transport">
          <div className="control-row">
            <div className="volume"><Volume1 size={17} /><input aria-label="Local volume" aria-valuetext={`${toWidgetVolume(props.volume)}% output`} type="range" min={0} max={100} value={props.volume} onChange={(event) => props.onVolume(Number(event.target.value))} /><Volume2 size={17} /></div>
            <div className="main-controls">
              <button onClick={() => sendWithWidgetPosition("playback:previous")} disabled={!current} title="Previous"><SkipBack /></button>
              <button className="play-button" onClick={() => props.snapshot.playback.playing ? sendWithWidgetPosition("playback:pause") : sendWithWidgetPosition("playback:play")} disabled={!current} title={props.snapshot.playback.playing ? "Pause" : "Play"}>{props.snapshot.playback.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button>
              <button onClick={() => props.command("playback:next")} disabled={!current} title="Next"><SkipForward /></button>
            </div>
            <div className="volume-spacer" />
          </div>
          {widget.needsAudioSync && <button className="sync-audio" onClick={widget.tapToSync}><RotateCcw size={16} /> Tap to sync audio</button>}
        </div>
      </section>

      <aside className="side-panel">
        <section className="listeners-card">
          <div className="section-title"><div><Users size={17} /><span>LISTENERS</span></div><b>{props.listeners.length}</b></div>
          <div className="listener-list">{props.listeners.map((listener, index) => <div className="listener" key={listener.id}><span className={`avatar tone-${index % 5}`}>{initials(listener.displayName)}</span><span>{listener.displayName}</span>{listener.isHost ? <span title="Room host"><Crown className="host-crown" /></span> : <i title="Connected" />}</div>)}</div>
        </section>

        <section className="queue-card">
          <div className="section-title"><div><ListMusic size={17} /><span>QUEUE</span></div><b>{props.snapshot.queue.length}/200</b></div>
          <form className="add-form" onSubmit={props.onAdd}><input value={props.trackUrl} onChange={(event) => props.setTrackUrl(event.target.value)} placeholder="Paste a SoundCloud track URL" /><button disabled={props.adding} title="Add track">{props.adding ? <LoaderCircle className="spin" /> : <CirclePlus />}</button></form>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
            <SortableContext items={props.snapshot.queue.map((item) => item.id)} strategy={verticalListSortingStrategy}>
              <div className="queue-list">{props.snapshot.queue.map((item, index) => <SortableTrack key={item.id} item={item} index={index} active={item.id === current?.id} count={props.snapshot.queue.length} move={(toIndex) => props.command("queue:move", { itemId: item.id, toIndex })} remove={() => props.command("queue:remove", { itemId: item.id })} />)}</div>
            </SortableContext>
          </DndContext>
          {props.snapshot.queue.length === 0 && <div className="empty-queue"><ListMusic /><p>No tracks yet</p><span>Paste a public track URL above.</span></div>}
        </section>
      </aside>
    </div>
    <footer>Playback powered by the official SoundCloud widget. Volume is local to this device.</footer>
  </main>;
}

function SortableTrack({ item, index, active, count, move, remove }: { item: QueueItem; index: number; active: boolean; count: number; move: (index: number) => void; remove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return <article ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`queue-item ${active ? "active" : ""} ${!item.available ? "unavailable" : ""} ${isDragging ? "dragging" : ""}`}>
    <button className="drag-handle" {...attributes} {...listeners} title="Drag to reorder"><GripVertical /></button>
    <span className="queue-index">{active ? <span className="mini-bars"><i /><i /><i /></span> : String(index + 1).padStart(2, "0")}</span>
    <div className="queue-info"><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a><span>{item.available ? `added by ${item.addedBy}` : "unavailable"}</span></div>
    <div className="item-actions"><button onClick={() => move(index - 1)} disabled={index === 0} title="Move up"><ChevronUp /></button><button onClick={() => move(index + 1)} disabled={index === count - 1} title="Move down"><ChevronDown /></button><button onClick={remove} title="Remove"><Trash2 /></button></div>
  </article>;
}

function useSoundCloudWidget(current: QueueItem | null, snapshot: RoomSnapshot, clockOffset: number, volume: number, command: RoomProps["command"]) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const widgetRef = useRef<SoundCloudWidget | null>(null);
  const currentRef = useRef(current);
  const snapshotRef = useRef(snapshot);
  const volumeRef = useRef(volume);
  const applyingUntil = useRef(0);
  const loadedItemId = useRef<string | null>(null);
  const [needsAudioSync, setNeedsAudioSync] = useState(false);
  currentRef.current = current;
  snapshotRef.current = snapshot;
  volumeRef.current = volume;

  const applyCanonical = useCallback((widget: SoundCloudWidget, forceSeek = false) => {
    const room = snapshotRef.current;
    const target = expectedPosition(room.playback, Date.now() + clockOffset);
    applyingUntil.current = Date.now() + 900;
    widget.setVolume(toWidgetVolume(volumeRef.current));
    widget.getPosition((actual) => {
      if (forceSeek || shouldCorrectDrift(actual, target)) widget.seekTo(target);
      if (room.playback.playing) {
        widget.play();
        setTimeout(() => widget.isPaused((paused) => setNeedsAudioSync(paused && snapshotRef.current.playback.playing)), 1200);
      } else {
        widget.pause();
        setNeedsAudioSync(false);
      }
    });
  }, [clockOffset]);

  useEffect(() => {
    if (!current || !iframeRef.current) return;
    let cancelled = false;
    loadWidgetApi().then(() => {
      if (cancelled || !iframeRef.current || !window.SC) return;
      const widget = window.SC.Widget(iframeRef.current);
      widgetRef.current = widget;
      const events = window.SC.Widget.Events;
      widget.bind(events.READY, () => {
        loadedItemId.current = currentRef.current?.id ?? null;
        widget.setVolume(toWidgetVolume(volumeRef.current));
        widget.getDuration((duration) => {
          const item = currentRef.current;
          if (item && duration > 0 && Math.abs((item.duration ?? 0) - duration) > 500) command("track:duration", { itemId: item.id, duration });
        });
        applyCanonical(widget, true);
      });
      widget.bind(events.PLAY, () => {
        if (Date.now() < applyingUntil.current) return;
        setNeedsAudioSync(false);
        widget.getPosition((position) => command("playback:play", { position }));
      });
      widget.bind(events.PAUSE, () => {
        if (Date.now() < applyingUntil.current) return;
        widget.getPosition((position) => {
          const item = currentRef.current;
          if (item?.duration && item.duration - position < 1_000) return;
          command("playback:pause", { position });
        });
      });
      widget.bind(events.SEEK, (event) => {
        if (Date.now() < applyingUntil.current) return;
        const send = (position: number) => command("playback:seek", { position });
        event?.currentPosition !== undefined ? send(event.currentPosition) : widget.getPosition(send);
      });
      widget.bind(events.FINISH, () => {
        const room = snapshotRef.current;
        const item = currentRef.current;
        if (item && room.playback.currentItemId === item.id) command("track:finish", { itemId: item.id });
      });
      widget.bind(events.ERROR, () => {
        const item = currentRef.current;
        if (item) command("track:error", { itemId: item.id });
      });
    });
    return () => {
      cancelled = true;
      const widget = widgetRef.current;
      if (widget && window.SC) {
        // Never navigate or remove the iframe when the queue becomes empty: some
        // browsers tear down the surrounding UI with SoundCloud's frame. Silence
        // and stop it through the Widget API, with brief retries for buffered audio.
        const stopIfEmpty = () => {
          if (currentRef.current) return;
          widget.setVolume(0);
          widget.pause();
          widget.seekTo(0);
        };
        stopIfEmpty();
        if (!currentRef.current) {
          window.setTimeout(stopIfEmpty, 150);
          window.setTimeout(stopIfEmpty, 600);
        }
        Object.values(window.SC.Widget.Events).forEach((event) => widget.unbind(event));
      }
      widgetRef.current = null;
    };
  }, [Boolean(current), command, applyCanonical]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !current) return;
    if (loadedItemId.current !== current.id) {
      loadedItemId.current = current.id;
      applyingUntil.current = Date.now() + 1500;
      widget.load(current.url, { auto_play: false, show_user: true, show_artwork: false, show_comments: false, color: "#ff5a1f", callback: () => applyCanonical(widget, true) });
    } else applyCanonical(widget);
  }, [current?.id, snapshot.revision, applyCanonical]);

  useEffect(() => { widgetRef.current?.setVolume(toWidgetVolume(volume)); }, [volume]);

  return {
    iframeRef, needsAudioSync,
    getPosition: (callback: (position: number) => void) => {
      const widget = widgetRef.current;
      if (widget) widget.getPosition(callback);
      else callback(expectedPosition(snapshot.playback, Date.now() + clockOffset));
    },
    tapToSync: () => { const widget = widgetRef.current; if (widget) { applyingUntil.current = Date.now() + 900; widget.setVolume(toWidgetVolume(volume)); widget.seekTo(expectedPosition(snapshot.playback, Date.now() + clockOffset)); widget.play(); setNeedsAudioSync(false); } },
  };
}

let widgetApiPromise: Promise<void> | null = null;
function loadWidgetApi(): Promise<void> {
  if (window.SC) return Promise.resolve();
  if (widgetApiPromise) return widgetApiPromise;
  widgetApiPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://w.soundcloud.com/player/api.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the SoundCloud player."));
    document.head.appendChild(script);
  });
  return widgetApiPromise;
}

async function calibrateClock(socket: RoomSocket, setOffset: (offset: number) => void) {
  const samples: ClockSample[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = Date.now();
    await new Promise<void>((resolve) => socket.emit("sync:ping", started, (server, echoed) => {
      const ended = Date.now();
      samples.push({ latency: ended - echoed, offset: server - (echoed + ended) / 2 });
      resolve();
    }));
  }
  setOffset(estimateClockOffset(samples));
}

function initials(name: string): string { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function connectionLabel(state: ConnectionState): string { return state === "connected" ? "LIVE" : state === "connecting" ? "CONNECTING" : state === "reconnecting" ? "RECONNECTING" : "OFFLINE"; }
function generatePin(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return String(random[0] % 1_000_000).padStart(6, "0");
}
