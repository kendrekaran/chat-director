# Chat Director

A localhost, MIT-licensed booth for a chat-controlled AI story livestream.

**YouTube chat → Codex or Cursor picks the next beat → Higgsfield MiniMax H3 renders it → OBS plays it.**

The host owns the premise, characters, visual style, and hard limits. Viewers only suggest. Completed scenes play automatically. The latest scene loops while the next one generates.

This is a starter you run on your own machine. It does not broadcast. OBS does that. Twitch, Kick, unattended agents, and direct streaming are out of scope for v1.

## Requirements

- Node.js 22+
- FFmpeg and ffprobe on `PATH`
- [Higgsfield CLI](https://github.com/higgsfield-ai/cli) only for live generation (`higgsfield auth login`)
- A Google Cloud OAuth client (YouTube Data API, read-only) only for live chat
- [Codex](https://developers.openai.com/codex/mcp) or [Cursor](https://cursor.com/docs/mcp) for live directing
- [OBS](https://obsproject.com/kb/browser-source) with a 1920×1080 browser source

## Quick demo (no credentials)

```bash
git clone https://github.com/kendrekaran/chat-director.git
cd chat-director
npm install
npm run fixtures
npm test
npm run build
npm start
```

Open `http://127.0.0.1:8787`. Unlock the desk with the token printed by the server (also written to `data/control-token`). Click **Start demo**.

Demo mode injects scripted chat from `fixtures/demo/chat-script.json` and uses bundled sample clips instead of Higgsfield. The optional **Demo auto-director** submits opening and follow-up scenes so you can verify the booth without attaching an agent. Live story sessions still require Codex or Cursor.

OBS browser source: `http://127.0.0.1:8787/overlay` at 1920×1080.

Development UI (API still on 8787):

```bash
npm run dev
```

Dashboard: `http://127.0.0.1:5173`

## Live session

1. Create a Google OAuth client in your own Cloud project. Authorized redirect:

   `http://127.0.0.1:8787/api/youtube/oauth/callback`

   Scope: `https://www.googleapis.com/auth/youtube.readonly`

2. In the dashboard, paste the client id and secret, authorize, then bind the live video ID. Chat IDs and the `nextPageToken` reconnect cursor are stored locally.

3. Install and authenticate the Higgsfield CLI. Chat Director calls `higgsfield generate create minimax_h3` with an argument array (`--duration`, `--aspect_ratio 16:9`, `--resolution 2K`, optional `--start-image`). There is no direct MiniMax API integration in v1.

4. Build the MCP bridge (`npm run build`) and point Codex or Cursor at `dist/mcp/index.js`. Examples:

   - [`config/cursor-mcp.json.example`](config/cursor-mcp.json.example)
   - [`config/codex-mcp.toml.example`](config/codex-mcp.toml.example)
   - Director prompt: [`config/director.prompt.md`](config/director.prompt.md)

5. Save setup, start **live**, then in the agent: `get_session` → write the opening scene → `wait_for_updates` → submit later beats with supporting message IDs.

If the agent disconnects, playback keeps looping the latest ready scene and the dashboard shows an inactive notice. Reconnect and call `get_session` again.

## Defaults and limits

Editable **before** start, then locked:

| Setting | Default |
|---|---|
| Scene length | 10 seconds |
| Aspect | 16:9 |
| Generation resolution | 2K |
| Concurrent generations | 1 |
| Submissions per session | 10 |

The submission count is a host cap, **not** a monetary spending guarantee. Provider pricing can change. The agent cannot raise its own allowance.

## Content boundaries

Viewer messages are story suggestions, never operational instructions. “Pause generation” or “increase the limit” in chat does nothing.

The director prompt asks the agent to skip hostile or off-premise lines. The application also flags host-defined blocked terms and refuses prompts that contain them. This is not comprehensive moderation.

## Security

- The HTTP server binds `127.0.0.1` by default.
- Control and agent routes require `X-Chat-Director-Token` (or `?token=` for EventSource).
- Overlay and media are localhost-only.
- `.gitignore` excludes `data/`, `.env`, credentials, chat records, and generated media.

## MCP tools

| Tool | Purpose |
|---|---|
| `get_session` | Snapshot: story, unread chat batch, jobs, remaining submissions |
| `wait_for_updates` | Long-poll from a `seq` |
| `submit_scene` | Prompt + supporting message IDs + proposed progression |

Shared TypeScript contracts live in `src/shared`.

## Project map

See [ARCHITECTURE.md](ARCHITECTURE.md).

```text
src/shared     contracts, overlay decisions, screening
src/server     Fastify, SQLite, worker, YouTube, Higgsfield argv, FFmpeg
src/mcp        stdio bridge
web/           host dashboard
public/overlay OBS page
fixtures/demo  sample clips + chat script
config/        MCP examples and director prompt
```

## Tests and CI

```bash
npm run typecheck
npm test
npm run build
```

GitHub Actions runs those three plus fixture generation. Coverage includes duplicate chat/proposals, story order, limit lock, hostile chat, provider rejection, ambiguous submit, restart recovery, and agent disconnect.

## Smoke test

```bash
npm run smoke
```

This checks local binaries and, if present, Higgsfield auth / YouTube credential files. It does **not** spend generation credit unless you set `SMOKE_LIVE=1`.

Live YouTube polling and paid MiniMax H3 generation are only verified when those credentials exist on the machine running the smoke test.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Dashboard 401 | Token in `data/control-token` vs the desk unlock field |
| Overlay is a holding card | No `ready` scene yet, or emergency hold is on |
| Overlay has no audio | Browser autoplay mute, or the dashboard mute toggle |
| Agent inactive banner | Codex/Cursor MCP not connected; playback still runs |
| `ambiguous` job | Crash or unclear provider response. Do not resubmit |
| YouTube “no active live chat” | Video is not live, or chat is disabled / ended |
| Higgsfield not found | `higgsfield` on `PATH`, then `higgsfield auth login` |
| FFmpeg prepare failed | `ffmpeg -version`, input is not a valid video |
| Limits grayed out | Session is running or paused — stop to edit |

## License

MIT. See [LICENSE](LICENSE).
