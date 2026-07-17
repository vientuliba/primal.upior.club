# Primal SoundCloud Listen-Along

A private room where the first listener becomes host and shares a six-digit PIN with friends. The Node service owns the queue and playback anchor in SQLite; browsers play tracks through SoundCloud's official visible widget.

## Local development

Requires Node.js 20 or newer.

```bash
npm ci
npm run dev
```

The Vite frontend runs on `http://localhost:5173` and proxies its socket and health requests to the service on `127.0.0.1:3001`. Local data is written to `./data` unless `DATA_DIR` is set.

```bash
npm run typecheck
npm test
npm run build
npm start
```

## Protocol and persistence

Socket authentication uses `{ displayName, pin, createRoom }`. The first listener creates a temporary room: the browser generates and copies a six-digit PIN, and the host shares it with guests. After the last listener has been gone for 15 seconds, the queue, playback state, and PIN are discarded. All mutations carry a UUID command ID and expected room revision, and return an acknowledgement. Duplicate commands are idempotent; stale commands are rejected with a fresh snapshot. The server broadcasts complete queue snapshots after mutations and playback anchors every five seconds.

SQLite runs in WAL mode and persists queue item order, metadata, availability, duration, current item, playback state, and revision. Browser volume never enters the socket protocol.

## Deployment

See [AGENTS.md](AGENTS.md) for the production paths and operations. With the `upior-vps` SSH alias authorized:

```bash
./deploy/deploy.sh
```

The deployment retains `/etc/primal/primal.env` and the SQLite database for operations and backups. Room sessions themselves are intentionally temporary and reset when the service starts or the room stays empty for 15 seconds.
