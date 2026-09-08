# Architecture

Chat Director is a localhost application with one active story session. Viewers suggest; a director agent chooses; Higgsfield (or bundled demo clips) renders; OBS plays.

```text
YouTube live chat ─┐
Demo chat script ──┼─► Fastify + SQLite ─► MCP stdio (get_session / wait_for_updates / submit_scene)
Host dashboard ────┤         │
                   │         ├─► generation worker (one job at a time)
                   │         │       Higgsfield CLI argv  or  fixtures/demo/clips
                   │         │       FFmpeg validate + browser MP4 + last frame
                   │         └─► /overlay 1920×1080 (OBS browser source)
```

## Processes

| Process | Role |
|---|---|
| `src/server` | HTTP API, SQLite, chat ingest, session controls, overlay, worker |
| `src/mcp` | stdio MCP bridge. HTTP client to the local API. No generation of its own |
| `web/` | Host dashboard (Vite / React) |
| Codex or Cursor | Required director for live mode. Optional in demo when auto-director is on |

The agent never talks to Higgsfield or YouTube directly. It cannot raise `maxSubmissions`.

## Persistence

`data/chat-director.sqlite` stores the session, chat (with original message IDs), jobs, story summaries, and an event sequence used by `wait_for_updates`.

`data/media/scenes/<jobId>/` stores `source.mp4`, `playback.mp4`, and `last-frame.jpg`.

`data/credentials/` stores the host Google OAuth client and YouTube tokens. `data/control-token` is the localhost control secret.

None of that directory is committed.

## Job lifecycle

1. `submit_scene` persists intent (`pending`) and the proposal hash.
2. The worker invokes the provider with an argument array (never a shell string).
3. On a known provider id the job becomes `submitted` / `generating`.
4. On success the file is downloaded, remuxed/transcoded for browsers, and the last frame is extracted.
5. Story state advances only after `ready`.

Recovery after a crash:

- `pending` without a provider id → `ambiguous`. **Not resubmitted.**
- `submitted` / `generating` with a provider id → poll that id.
- `downloading` / `preparing` with a known path or URL → retry those steps only.

## Overlay

`/overlay` is a pair of stacked `<video>` elements. The latest ready scene loops. When a newer ready scene appears it is preloaded on the hidden player and swapped on `ended`, so the transition does not clear to an empty frame. Refresh re-fetches `/api/overlay/state` and resumes the latest clip. Emergency hold covers the stage with the holding card.

## Chat

YouTube polling uses [`liveChatMessages.list`](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list), stores `nextPageToken`, and sleeps `pollingIntervalMillis`. Disabled or ended chat is recorded and polling stops. Duplicate message IDs are ignored. Blocked-term matches are flagged and withheld from the unread batch. Operational-sounding chat is still stored as text and is never executed.
