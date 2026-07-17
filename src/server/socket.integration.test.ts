import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, RoomSnapshot, ServerToClientEvents } from "../shared/protocol";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const pin = "123456";
let port: number;
let child: ChildProcess;
let dataDir: string;

beforeAll(async () => {
  port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "primal-integration-"));
  child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "src/server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, EMPTY_ROOM_RESET_MS: "500", DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Integration server did not start");
}, 30_000);

afterAll(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolveWait) => child.once("exit", resolveWait));
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("Socket.IO room API", () => {
  it("reports an empty room and requires an explicit create request", async () => {
    expect(await roomStatus()).toEqual({ active: false });
    const socket = io(`http://127.0.0.1:${port}`, { auth: { displayName: "Evan", pin }, reconnection: false });
    const message = await new Promise<string>((resolveMessage) => socket.on("connect_error", (error) => resolveMessage(error.message)));
    expect(message).toMatch(/room is empty/i);
    socket.close();
  });

  it("rejects an invalid display name before joining", async () => {
    const socket = io(`http://127.0.0.1:${port}`, { auth: { displayName: "", pin, createRoom: true }, reconnection: false });
    const message = await new Promise<string>((resolveMessage) => socket.on("connect_error", (error) => resolveMessage(error.message)));
    expect(message).toMatch(/valid display name/i);
    socket.close();
  });

  it("acknowledges structured errors and sends a snapshot again after reconnect", async () => {
    const { socket: first, snapshot: initial } = await connectClient("Alice", pin, true);
    const ack = await new Promise<{ ok: boolean; revision: number; error?: { code: string } }>((resolveAck) => first.emit("playback:play", {
      commandId: "00000000-0000-4000-8000-000000000101", revision: initial.revision,
    }, resolveAck));
    expect(ack).toMatchObject({ ok: false, revision: initial.revision, error: { code: "NOT_FOUND" } });
    first.close();

    const { socket: second, snapshot: reconnected } = await connectClient("Alice");
    expect(reconnected).toMatchObject({ revision: initial.revision, queue: [] });
    second.close();
  });

  it("lets the first listener create a PIN and requires it for guests", async () => {
    await waitForInactive();
    const host = await connectClient("Host", pin, true);
    expect(host.session).toEqual({ isHost: true, pin });
    expect(await roomStatus()).toEqual({ active: true });

    const rejected = io(`http://127.0.0.1:${port}`, { auth: { displayName: "Wrong pin", pin: "000000" }, reconnection: false });
    const message = await new Promise<string>((resolveMessage) => rejected.on("connect_error", (error) => resolveMessage(error.message)));
    expect(message).toMatch(/incorrect/i);
    rejected.close();

    const guest = await connectClient("Guest", pin);
    expect(guest.session).toEqual({ isHost: false, pin: null });
    host.socket.close();
    const promoted = await sessionFrom(guest.socket, (session) => session.isHost);
    expect(promoted).toEqual({ isHost: true, pin });
    guest.socket.close();
    await waitForInactive();
    expect(await roomStatus()).toEqual({ active: false });

    const stalePin = io(`http://127.0.0.1:${port}`, { auth: { displayName: "Late guest", pin }, reconnection: false });
    const staleMessage = await new Promise<string>((resolveMessage) => stalePin.on("connect_error", (error) => resolveMessage(error.message)));
    expect(staleMessage).toMatch(/room is empty/i);
    stalePin.close();
  });
});

function connectClient(displayName: string, suppliedPin = pin, createRoom = false): Promise<{ socket: TestSocket; snapshot: RoomSnapshot; session: { isHost: boolean; pin: string | null } }> {
  return new Promise((resolveSocket, reject) => {
    const socket: TestSocket = io(`http://127.0.0.1:${port}`, { auth: { displayName, pin: suppliedPin, createRoom }, reconnection: false });
    let connected = false;
    let snapshot: RoomSnapshot | undefined;
    let session: { isHost: boolean; pin: string | null } | undefined;
    const complete = () => { if (connected && snapshot && session) resolveSocket({ socket, snapshot, session }); };
    socket.once("connect", () => { connected = true; complete(); });
    socket.once("room:snapshot", (room) => { snapshot = room; complete(); });
    socket.once("session:update", (info) => { session = info; complete(); });
    socket.once("connect_error", reject);
  });
}

async function roomStatus(): Promise<{ active: boolean }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/status`);
  return response.json() as Promise<{ active: boolean }>;
}

async function waitForInactive(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await roomStatus()).active) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Room did not reset after its last listener left");
}

function sessionFrom(socket: TestSocket, predicate: (session: { isHost: boolean; pin: string | null }) => boolean = () => true): Promise<{ isHost: boolean; pin: string | null }> {
  return new Promise((resolveSession) => {
    const handler = (session: { isHost: boolean; pin: string | null }) => {
      if (!predicate(session)) return;
      socket.off("session:update", handler);
      resolveSession(session);
    };
    socket.on("session:update", handler);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP port"));
      server.close(() => resolvePort(address.port));
    });
  });
}
