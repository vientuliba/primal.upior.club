// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, (value?: unknown) => void>();
  const socket = {
    auth: {},
    connected: false,
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (value?: unknown) => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    io: { on: vi.fn() },
  };
  return { handlers, socket, io: vi.fn(() => socket) };
});

vi.mock("socket.io-client", () => ({ io: socketMock.io }));

describe("room authentication screen", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    localStorage.setItem("primal:name", "Visitor");
    localStorage.setItem("primal:pin", "000000");
    socketMock.handlers.clear();
    socketMock.io.mockClear();
    socketMock.socket.disconnect.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ active: true }) })));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(<App />); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("never renders the room while an incorrect PIN is being rejected", async () => {
    const form = container.querySelector("form");
    expect(form).not.toBeNull();

    await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

    expect(container.querySelector(".app-shell")).toBeNull();
    expect(container.querySelector(".join-shell")).not.toBeNull();
    expect(container.textContent).toContain("Checking PIN…");

    await act(async () => { socketMock.handlers.get("connect_error")?.(new Error("That six-digit PIN is incorrect.")); });

    expect(container.querySelector(".app-shell")).toBeNull();
    expect(container.querySelector(".join-shell")).not.toBeNull();
    expect(container.textContent).toContain("That six-digit PIN is incorrect.");
  });

  it("renders PIN and listeners together only after the complete room state arrives", async () => {
    const form = container.querySelector("form");
    await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

    await act(async () => { socketMock.handlers.get("connect")?.(); });

    expect(container.querySelector(".app-shell")).toBeNull();
    expect(container.querySelector(".join-shell")).not.toBeNull();
    expect(container.textContent).toContain("Checking PIN…");

    await act(async () => {
      socketMock.handlers.get("room:ready")?.({
        snapshot: {
          queue: [],
          playback: { currentItemId: null, playing: false, anchorPosition: 0, anchorTimestamp: 0 },
          revision: 0,
          serverTimestamp: Date.now(),
        },
        listeners: [
          { id: "host", displayName: "Host", isHost: true },
          { id: "visitor", displayName: "Visitor", isHost: false },
        ],
        session: { isHost: true, pin: "123456" },
      });
    });

    expect(container.querySelector(".join-shell")).toBeNull();
    expect(container.querySelector(".app-shell")).not.toBeNull();
    expect(container.querySelector(".host-pin")?.textContent).toContain("123456");
    expect(container.querySelector(".listener-list")?.textContent).toContain("Host");
    expect(container.querySelector(".listener-list")?.textContent).toContain("Visitor");
  });
});
