import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { Server } from "socket.io";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ClientToServerEvents, CommandAck, PresenceEntry, RoomError, ServerToClientEvents } from "../shared/protocol.js";
import { RoomCommandError, RoomStore } from "./room.js";
import { resolveTrack } from "./soundcloud.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
const emptyRoomResetMs = Number(process.env.EMPTY_ROOM_RESET_MS ?? 15_000);
mkdirSync(dataDir, { recursive: true });

const app = Fastify({ logger: true, trustProxy: true });
const room = new RoomStore(resolve(dataDir, "primal.db"));
let currentPin: string | null = null;
let indexTemplate: string | undefined;
// A process without connected listeners cannot carry an active temporary session.
room.resetRoom();
await app.register(fastifyStatic, { root: resolve(process.cwd(), "dist"), wildcard: false, index: false });
app.get("/api/health", async () => ({ ok: true, revision: room.snapshot().revision }));
app.get("/api/status", async () => ({ active: currentPin !== null }));
app.setNotFoundHandler((request, reply) => {
  if (request.raw.url?.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
  const builtIndex = resolve(process.cwd(), "dist/index.html");
  indexTemplate ??= readFileSync(existsSync(builtIndex) ? builtIndex : resolve(process.cwd(), "index.html"), "utf8");
  const statusScript = `<script>window.__PRIMAL_ROOM_ACTIVE__=${currentPin !== null};</script>`;
  return reply.header("Cache-Control", "no-store").type("text/html").send(indexTemplate.replace("</head>", `${statusScript}</head>`));
});

interface SocketData { displayName: string; isHost: boolean }
const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(app.server, {
  maxHttpBufferSize: 32 * 1024,
  transports: ["websocket", "polling"],
});
const authSchema = z.object({
  displayName: z.string().trim().min(1).max(32).regex(/^[^\u0000-\u001f\u007f]+$/),
  pin: z.string().regex(/^\d{6}$/),
  createRoom: z.boolean().optional().default(false),
});
const baseSchema = z.object({ commandId: z.string().uuid(), revision: z.number().int().nonnegative() });
const positions = z.number().finite().nonnegative().max(86_400_000);
const listeners = new Map<string, PresenceEntry>();
let emptyRoomTimer: NodeJS.Timeout | undefined;
let hostReservation: string | null = null;

io.use((socket, next) => {
  const result = authSchema.safeParse(socket.handshake.auth);
  if (!result.success) return next(new Error("Enter a valid display name and six-digit PIN."));
  const mayCreate = currentPin === null && listeners.size === 0 && hostReservation === null && result.data.createRoom;
  if (mayCreate) {
    currentPin = result.data.pin;
    room.resetRoom();
    hostReservation = socket.id;
    socket.data.isHost = true;
  } else {
    if (currentPin === null) return next(new Error("The room is empty. Start a new room to become host."));
    if (result.data.pin !== currentPin) return next(new Error("That six-digit PIN is incorrect."));
    const becomesHost = listeners.size === 0 && hostReservation === null;
    if (becomesHost) hostReservation = socket.id;
    socket.data.isHost = becomesHost;
  }
  socket.data.displayName = result.data.displayName;
  next();
});

io.on("connection", (socket) => {
  if (emptyRoomTimer) clearTimeout(emptyRoomTimer);
  if (socket.data.isHost) hostReservation = socket.id;
  listeners.set(socket.id, { id: socket.id, displayName: socket.data.displayName, isHost: socket.data.isHost });
  socket.emit("room:snapshot", room.snapshot());
  emitSessions();

  socket.on("sync:ping", (clientTimestamp, ack) => ack(Date.now(), clientTimestamp));

  socket.on("queue:add", (raw, ack) => handle(socket, ack, async () => {
    const payload = baseSchema.extend({ url: z.string().min(1).max(2048) }).parse(raw);
    const metadata = await resolveTrack(payload.url);
    return room.add(payload.commandId, payload.revision, metadata, socket.data.displayName);
  }));
  socket.on("queue:remove", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.extend({ itemId: z.string().uuid() }).parse(raw);
    return room.remove(payload.commandId, payload.revision, payload.itemId);
  }));
  socket.on("queue:move", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.extend({ itemId: z.string().uuid(), toIndex: z.number().int().nonnegative().max(199) }).parse(raw);
    return room.move(payload.commandId, payload.revision, payload.itemId, payload.toIndex);
  }));
  socket.on("playback:play", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.extend({ position: positions.optional() }).parse(raw);
    return room.play(payload.commandId, payload.revision, payload.position);
  }));
  socket.on("playback:pause", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.extend({ position: positions.optional() }).parse(raw);
    return room.pause(payload.commandId, payload.revision, payload.position);
  }));
  socket.on("playback:seek", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.extend({ position: positions }).parse(raw);
    return room.seek(payload.commandId, payload.revision, payload.position);
  }));
  socket.on("playback:next", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.parse(raw);
    return room.next(payload.commandId, payload.revision);
  }));
  socket.on("playback:previous", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.extend({ position: positions.optional() }).parse(raw);
    return room.previous(payload.commandId, payload.revision, payload.position);
  }));
  socket.on("track:duration", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.extend({ itemId: z.string().uuid(), duration: positions.positive() }).parse(raw);
    return room.duration(payload.commandId, payload.revision, payload.itemId, payload.duration);
  }));
  socket.on("track:finish", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.extend({ itemId: z.string().uuid() }).parse(raw);
    return room.finish(payload.commandId, payload.revision, payload.itemId);
  }));
  socket.on("track:error", (raw, ack) => handle(socket, ack, () => {
    const payload = baseSchema.extend({ itemId: z.string().uuid() }).parse(raw);
    return room.unavailable(payload.commandId, payload.revision, payload.itemId);
  }));

  socket.on("disconnect", () => {
    const wasHost = socket.data.isHost;
    listeners.delete(socket.id);
    if (wasHost) {
      hostReservation = null;
      const nextHost = listeners.values().next().value as PresenceEntry | undefined;
      if (nextHost) {
        nextHost.isHost = true;
        hostReservation = nextHost.id;
        const promoted = io.sockets.sockets.get(nextHost.id);
        if (promoted) promoted.data.isHost = true;
      }
    }
    emitSessions();
    if (listeners.size === 0) {
      hostReservation = null;
      emptyRoomTimer = setTimeout(() => {
        if (listeners.size === 0) {
          room.resetRoom();
          currentPin = null;
          hostReservation = null;
        }
      }, emptyRoomResetMs);
    }
  });
});

function emitSessions(): void {
  io.emit("presence:update", [...listeners.values()]);
  for (const socket of io.sockets.sockets.values()) {
    socket.emit("session:update", { isHost: socket.data.isHost, pin: socket.data.isHost ? currentPin : null });
  }
}

async function handle(
  socket: Parameters<Parameters<typeof io.on>[1]>[0],
  ack: (result: CommandAck) => void,
  action: () => ReturnType<RoomStore["add"]> | Promise<ReturnType<RoomStore["add"]>>,
): Promise<void> {
  try {
    const result = await action();
    ack({ ok: true, revision: result.snapshot.revision, duplicate: result.duplicate });
    if (!result.duplicate) io.emit("room:snapshot", result.snapshot);
  } catch (cause) {
    const error = toRoomError(cause);
    ack({ ok: false, revision: room.snapshot().revision, error });
    if (error.code === "STALE_REVISION") socket.emit("room:snapshot", room.snapshot());
    else socket.emit("room:error", error);
  }
}

function toRoomError(cause: unknown): RoomError {
  if (cause instanceof RoomCommandError) return { code: cause.code as RoomError["code"], message: cause.message };
  if (cause instanceof z.ZodError) return { code: "INVALID_COMMAND", message: cause.issues[0]?.message ?? "Invalid command." };
  app.log.error(cause);
  return { code: "INTERNAL_ERROR", message: "The room could not apply that command." };
}

const syncTimer = setInterval(() => io.emit("playback:sync", room.snapshot()), 5_000);
const shutdown = async () => {
  clearInterval(syncTimer);
  if (emptyRoomTimer) clearTimeout(emptyRoomTimer);
  io.close();
  room.close();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port, host });
