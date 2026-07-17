import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { PlaybackState, QueueItem, RoomSnapshot } from "../shared/protocol.js";
import { expectedPosition } from "../shared/protocol.js";

interface StateRow {
  current_item_id: string | null;
  playing: number;
  anchor_position: number;
  anchor_timestamp: number;
  revision: number;
}

interface ItemRow {
  id: string;
  position: number;
  url: string;
  title: string;
  artwork_url: string | null;
  added_by: string;
  created_at: number;
  duration: number | null;
  available: number;
}

export interface TrackMetadata {
  url: string;
  title: string;
  artworkUrl: string | null;
}

export class RoomCommandError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface MutationResult { snapshot: RoomSnapshot; duplicate: boolean }

export class RoomStore {
  readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        artwork_url TEXT,
        added_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        duration INTEGER,
        available INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS queue_position_idx ON queue_items(position);
      CREATE TABLE IF NOT EXISTS room_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_item_id TEXT,
        playing INTEGER NOT NULL,
        anchor_position REAL NOT NULL,
        anchor_timestamp INTEGER NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_commands (
        command_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.prepare(`INSERT OR IGNORE INTO room_state
      (id, current_item_id, playing, anchor_position, anchor_timestamp, revision)
      VALUES (1, NULL, 0, 0, ?, 0)`).run(Date.now());
  }

  close(): void { this.db.close(); }

  snapshot(now = Date.now()): RoomSnapshot {
    const rows = this.db.prepare("SELECT * FROM queue_items ORDER BY position, created_at").all() as ItemRow[];
    const state = this.state();
    return {
      queue: rows.map(toItem),
      playback: toPlayback(state),
      revision: state.revision,
      serverTimestamp: now,
    };
  }

  add(commandId: string, revision: number, metadata: TrackMetadata, addedBy: string, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, (state) => {
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM queue_items").get() as { count: number };
      if (count.count >= 200) throw new RoomCommandError("QUEUE_FULL", "The queue is limited to 200 tracks.");
      const itemId = randomUUID();
      this.db.prepare(`INSERT INTO queue_items
        (id, position, url, title, artwork_url, added_by, created_at, duration, available)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`)
        .run(itemId, count.count, metadata.url, metadata.title, metadata.artworkUrl, addedBy, now);
      if (state.current_item_id === null) {
        state.current_item_id = itemId;
        state.anchor_position = 0;
        state.anchor_timestamp = now;
      }
    });
  }

  remove(commandId: string, revision: number, itemId: string, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, (state) => {
      const items = this.items();
      const index = items.findIndex((item) => item.id === itemId);
      if (index < 0) throw new RoomCommandError("NOT_FOUND", "That queue item no longer exists.");
      this.db.prepare("DELETE FROM queue_items WHERE id = ?").run(itemId);
      if (state.current_item_id === itemId) {
        const next = items.slice(index + 1).find((item) => item.available);
        state.current_item_id = next?.id ?? null;
        state.anchor_position = 0;
        state.anchor_timestamp = now;
        if (!next) state.playing = 0;
      }
      this.normalizePositions();
    });
  }

  move(commandId: string, revision: number, itemId: string, toIndex: number, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, () => {
      const items = this.items();
      const fromIndex = items.findIndex((item) => item.id === itemId);
      if (fromIndex < 0) throw new RoomCommandError("NOT_FOUND", "That queue item no longer exists.");
      const destination = Math.max(0, Math.min(Math.trunc(toIndex), items.length - 1));
      const [item] = items.splice(fromIndex, 1);
      items.splice(destination, 0, item);
      const update = this.db.prepare("UPDATE queue_items SET position = ? WHERE id = ?");
      items.forEach((entry, index) => update.run(index, entry.id));
    });
  }

  play(commandId: string, revision: number, position?: number, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, (state) => {
      if (!state.current_item_id) {
        const first = this.items().find((item) => item.available);
        if (!first) throw new RoomCommandError("NOT_FOUND", "Add an available track before playing.");
        state.current_item_id = first.id;
        state.anchor_position = 0;
      } else if (state.playing) {
        state.anchor_position = expectedPosition(toPlayback(state), now);
      }
      if (position !== undefined) state.anchor_position = clampPosition(position, this.item(state.current_item_id)?.duration);
      state.playing = 1;
      state.anchor_timestamp = now;
    });
  }

  pause(commandId: string, revision: number, position?: number, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, (state) => {
      const projected = expectedPosition(toPlayback(state), now);
      state.anchor_position = clampPosition(position ?? projected, this.item(state.current_item_id)?.duration);
      state.playing = 0;
      state.anchor_timestamp = now;
    });
  }

  seek(commandId: string, revision: number, position: number, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, (state) => {
      if (!state.current_item_id) throw new RoomCommandError("NOT_FOUND", "There is no current track.");
      state.anchor_position = clampPosition(position, this.item(state.current_item_id)?.duration);
      state.anchor_timestamp = now;
    });
  }

  next(commandId: string, revision: number, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, (state) => {
      const items = this.items();
      const index = items.findIndex((item) => item.id === state.current_item_id);
      const next = items.slice(index + 1).find((item) => item.available);
      if (next) {
        state.current_item_id = next.id;
        state.anchor_position = 0;
        state.anchor_timestamp = now;
        return;
      }

      // Explicitly skipping past the final track ends this temporary queue.
      this.db.prepare("DELETE FROM queue_items").run();
      state.current_item_id = null;
      state.playing = 0;
      state.anchor_position = 0;
      state.anchor_timestamp = now;
    });
  }

  previous(commandId: string, revision: number, position?: number, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, (state) => {
      const currentPosition = position ?? expectedPosition(toPlayback(state), now);
      if (currentPosition > 3000) {
        state.anchor_position = 0;
        state.anchor_timestamp = now;
        return;
      }
      const items = this.items();
      const index = items.findIndex((item) => item.id === state.current_item_id);
      const previous = items.slice(0, Math.max(0, index)).reverse().find((item) => item.available);
      if (previous) state.current_item_id = previous.id;
      state.anchor_position = 0;
      state.anchor_timestamp = now;
    });
  }

  duration(commandId: string, revision: number, itemId: string, duration: number, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, () => {
      const result = this.db.prepare("UPDATE queue_items SET duration = ? WHERE id = ?").run(Math.round(duration), itemId);
      if (result.changes === 0) throw new RoomCommandError("NOT_FOUND", "That queue item no longer exists.");
    });
  }

  finish(commandId: string, revision: number, itemId: string, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, (state) => {
      if (state.current_item_id !== itemId) throw new RoomCommandError("STALE_REVISION", "This finish event is no longer current.");
      this.advance(state, now);
    });
  }

  unavailable(commandId: string, revision: number, itemId: string, now = Date.now()): MutationResult {
    return this.mutate(commandId, revision, now, (state) => {
      const result = this.db.prepare("UPDATE queue_items SET available = 0 WHERE id = ?").run(itemId);
      if (result.changes === 0) throw new RoomCommandError("NOT_FOUND", "That queue item no longer exists.");
      if (state.current_item_id === itemId) this.advance(state, now);
    });
  }

  pauseForEmptyRoom(now = Date.now()): RoomSnapshot {
    const transaction = this.db.transaction(() => {
      const state = this.state();
      if (!state.playing) return;
      state.anchor_position = expectedPosition(toPlayback(state), now);
      state.anchor_timestamp = now;
      state.playing = 0;
      state.revision += 1;
      this.saveState(state);
    });
    transaction();
    return this.snapshot(now);
  }

  resetRoom(now = Date.now()): RoomSnapshot {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM queue_items").run();
      this.db.prepare("DELETE FROM processed_commands").run();
      this.db.prepare(`UPDATE room_state SET current_item_id = NULL, playing = 0,
        anchor_position = 0, anchor_timestamp = ?, revision = 0 WHERE id = 1`).run(now);
    });
    transaction();
    return this.snapshot(now);
  }

  private mutate(commandId: string, expectedRevision: number, now: number, change: (state: StateRow) => void): MutationResult {
    let duplicate = false;
    const transaction = this.db.transaction(() => {
      const seen = this.db.prepare("SELECT 1 FROM processed_commands WHERE command_id = ?").get(commandId);
      if (seen) { duplicate = true; return; }
      const state = this.state();
      if (state.revision !== expectedRevision) {
        throw new RoomCommandError("STALE_REVISION", `Room changed from revision ${expectedRevision} to ${state.revision}.`);
      }
      change(state);
      state.revision += 1;
      this.saveState(state);
      this.db.prepare("INSERT INTO processed_commands(command_id, created_at) VALUES (?, ?)").run(commandId, now);
      this.db.prepare("DELETE FROM processed_commands WHERE created_at < ?").run(now - 86_400_000);
    });
    transaction();
    return { snapshot: this.snapshot(now), duplicate };
  }

  private advance(state: StateRow, now: number): void {
    const items = this.items();
    const index = items.findIndex((item) => item.id === state.current_item_id);
    const next = items.slice(index + 1).find((item) => item.available);
    if (next) {
      state.current_item_id = next.id;
      state.anchor_position = 0;
    } else {
      state.anchor_position = this.item(state.current_item_id)?.duration ?? state.anchor_position;
      state.playing = 0;
    }
    state.anchor_timestamp = now;
  }

  private state(): StateRow {
    return this.db.prepare("SELECT * FROM room_state WHERE id = 1").get() as StateRow;
  }

  private saveState(state: StateRow): void {
    this.db.prepare(`UPDATE room_state SET current_item_id = ?, playing = ?, anchor_position = ?,
      anchor_timestamp = ?, revision = ? WHERE id = 1`).run(
      state.current_item_id, state.playing, state.anchor_position, state.anchor_timestamp, state.revision,
    );
  }

  private items(): QueueItem[] {
    return (this.db.prepare("SELECT * FROM queue_items ORDER BY position, created_at").all() as ItemRow[]).map(toItem);
  }

  private item(id: string | null): QueueItem | undefined {
    if (!id) return undefined;
    const row = this.db.prepare("SELECT * FROM queue_items WHERE id = ?").get(id) as ItemRow | undefined;
    return row ? toItem(row) : undefined;
  }

  private normalizePositions(): void {
    const update = this.db.prepare("UPDATE queue_items SET position = ? WHERE id = ?");
    this.items().forEach((item, index) => update.run(index, item.id));
  }
}

function toItem(row: ItemRow): QueueItem {
  return {
    id: row.id, position: row.position, url: row.url, title: row.title,
    artworkUrl: row.artwork_url, addedBy: row.added_by, createdAt: row.created_at,
    duration: row.duration, available: Boolean(row.available),
  };
}

function toPlayback(row: StateRow): PlaybackState {
  return {
    currentItemId: row.current_item_id,
    playing: Boolean(row.playing),
    anchorPosition: row.anchor_position,
    anchorTimestamp: row.anchor_timestamp,
  };
}

function clampPosition(position: number, duration?: number | null): number {
  if (!Number.isFinite(position)) throw new RoomCommandError("INVALID_COMMAND", "Position must be finite.");
  return Math.max(0, duration ? Math.min(position, duration) : position);
}
