import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "./room";

const stores: RoomStore[] = [];
const makeRoom = () => { const room = new RoomStore(":memory:"); stores.push(room); return room; };
const meta = (title: string) => ({ url: `https://soundcloud.com/artist/${title.toLowerCase()}`, title, artworkUrl: null });
const add = (room: RoomStore, command: string, title: string, now = 1_000) => room.add(command, room.snapshot().revision, meta(title), "Evan", now);
afterEach(() => stores.splice(0).forEach((room) => room.close()));

describe("RoomStore queue", () => {
  it("inserts duplicates and selects the first item without autoplaying", () => {
    const room = makeRoom();
    add(room, "00000000-0000-4000-8000-000000000001", "One");
    add(room, "00000000-0000-4000-8000-000000000002", "One");
    const snapshot = room.snapshot();
    expect(snapshot.queue).toHaveLength(2);
    expect(snapshot.queue[0].id).not.toBe(snapshot.queue[1].id);
    expect(snapshot.playback).toMatchObject({ currentItemId: snapshot.queue[0].id, playing: false });
  });

  it("reorders without changing the playing item", () => {
    const room = makeRoom();
    add(room, "00000000-0000-4000-8000-000000000011", "One");
    add(room, "00000000-0000-4000-8000-000000000012", "Two");
    const before = room.snapshot();
    room.play("00000000-0000-4000-8000-000000000013", before.revision, 500, 2_000);
    const currentId = room.snapshot().playback.currentItemId;
    room.move("00000000-0000-4000-8000-000000000014", room.snapshot().revision, currentId!, 1, 2_100);
    expect(room.snapshot().playback.currentItemId).toBe(currentId);
    expect(room.snapshot().queue[1].id).toBe(currentId);
  });

  it("removing the current item advances to the next available item", () => {
    const room = makeRoom();
    add(room, "00000000-0000-4000-8000-000000000021", "One");
    add(room, "00000000-0000-4000-8000-000000000022", "Two");
    const [first, second] = room.snapshot().queue;
    room.play("00000000-0000-4000-8000-000000000023", room.snapshot().revision, 0, 2_000);
    room.remove("00000000-0000-4000-8000-000000000024", room.snapshot().revision, first.id, 2_100);
    expect(room.snapshot().playback).toMatchObject({ currentItemId: second.id, playing: true, anchorPosition: 0 });
  });
});

describe("RoomStore playback", () => {
  it("clears the whole queue when next is pressed on the final item", () => {
    const room = makeRoom();
    add(room, "00000000-0000-4000-8000-000000000025", "One");
    add(room, "00000000-0000-4000-8000-000000000026", "Two");
    room.play("00000000-0000-4000-8000-000000000027", room.snapshot().revision, 0, 2_000);
    room.next("00000000-0000-4000-8000-000000000028", room.snapshot().revision, 2_100);
    const cleared = room.next("00000000-0000-4000-8000-000000000029", room.snapshot().revision, 2_200).snapshot;
    expect(cleared.queue).toEqual([]);
    expect(cleared.playback).toMatchObject({ currentItemId: null, playing: false, anchorPosition: 0, anchorTimestamp: 2_200 });
  });

  it("previous restarts after three seconds, then moves backward", () => {
    const room = makeRoom();
    add(room, "00000000-0000-4000-8000-000000000031", "One");
    add(room, "00000000-0000-4000-8000-000000000032", "Two");
    room.next("00000000-0000-4000-8000-000000000033", room.snapshot().revision, 2_000);
    const second = room.snapshot().playback.currentItemId;
    room.previous("00000000-0000-4000-8000-000000000034", room.snapshot().revision, 3_001, 3_000);
    expect(room.snapshot().playback).toMatchObject({ currentItemId: second, anchorPosition: 0 });
    room.previous("00000000-0000-4000-8000-000000000035", room.snapshot().revision, 2_000, 4_000);
    expect(room.snapshot().playback.currentItemId).toBe(room.snapshot().queue[0].id);
  });

  it("finishing the last item pauses at its duration and deduplicates finish commands", () => {
    const room = makeRoom();
    add(room, "00000000-0000-4000-8000-000000000041", "One");
    const item = room.snapshot().queue[0];
    room.duration("00000000-0000-4000-8000-000000000042", room.snapshot().revision, item.id, 12_000, 2_000);
    room.play("00000000-0000-4000-8000-000000000043", room.snapshot().revision, 0, 2_100);
    const finishRevision = room.snapshot().revision;
    const result = room.finish("00000000-0000-4000-8000-000000000044", finishRevision, item.id, 14_100);
    expect(result.snapshot.playback).toMatchObject({ playing: false, anchorPosition: 12_000 });
    const duplicate = room.finish("00000000-0000-4000-8000-000000000044", finishRevision, item.id, 14_200);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.snapshot.revision).toBe(result.snapshot.revision);
  });

  it("rejects stale revisions and applies a command ID only once", () => {
    const room = makeRoom();
    add(room, "00000000-0000-4000-8000-000000000051", "One");
    const revision = room.snapshot().revision;
    room.play("00000000-0000-4000-8000-000000000052", revision, 0, 2_000);
    expect(() => room.pause("00000000-0000-4000-8000-000000000053", revision, 1_000, 3_000)).toThrow(/revision/i);
    expect(room.play("00000000-0000-4000-8000-000000000052", revision, 0, 4_000).duplicate).toBe(true);
  });

  it("pauses at the projected anchor when the room remains empty", () => {
    const room = makeRoom();
    add(room, "00000000-0000-4000-8000-000000000061", "One", 1_000);
    room.play("00000000-0000-4000-8000-000000000062", room.snapshot().revision, 500, 2_000);
    const paused = room.pauseForEmptyRoom(17_000);
    expect(paused.playback).toMatchObject({ playing: false, anchorPosition: 15_500, anchorTimestamp: 17_000 });
  });
});

describe("RoomStore persistence", () => {
  it("recovers the queue, playback anchor, and revision after a database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "primal-restart-"));
    const filename = join(directory, "room.db");
    const first = new RoomStore(filename);
    add(first, "00000000-0000-4000-8000-000000000071", "Persistent", 1_000);
    first.play("00000000-0000-4000-8000-000000000072", first.snapshot().revision, 2_500, 2_000);
    const before = first.snapshot(2_000);
    first.close();

    const restarted = new RoomStore(filename);
    expect(restarted.snapshot(2_000)).toMatchObject({
      queue: [{ title: "Persistent" }],
      playback: { currentItemId: before.playback.currentItemId, playing: true, anchorPosition: 2_500 },
      revision: before.revision,
    });
    restarted.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("RoomStore temporary sessions", () => {
  it("clears every queue and playback field when the lobby resets", () => {
    const room = makeRoom();
    add(room, "00000000-0000-4000-8000-000000000081", "Temporary", 1_000);
    room.play("00000000-0000-4000-8000-000000000082", room.snapshot().revision, 2_000, 2_000);
    const reset = room.resetRoom(20_000);
    expect(reset).toMatchObject({
      queue: [], revision: 0,
      playback: { currentItemId: null, playing: false, anchorPosition: 0, anchorTimestamp: 20_000 },
    });
  });
});
