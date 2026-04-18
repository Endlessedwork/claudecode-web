# Claude Code Web UI

## Project Overview
Web UI for Claude Code CLI (and potentially other CLI tools). Built with Express + WebSocket + vanilla JS.

## Quick Start
```bash
cd /Users/alone/AiCode/claudecode-web
node server.js
# Open http://localhost:3003
```

## For New Sessions
**Read `SESSION_HANDOFF.md` first** — it contains the current project status, completed features, pending tasks, and architecture overview.

## Tech Stack
- Backend: Node.js, Express, WebSocket (`ws`), `node-pty@0.10.1`, `better-sqlite3`
- Frontend: Single-page vanilla JS, CSS custom properties, Heroicons SVG
- Port: 3003 (bound to `0.0.0.0`)

## Important Notes
- Do NOT run `node server.js` as a background task — it will be killed by heartbeat timeout. Run directly in terminal.
- `node-pty` is pinned to `0.10.1` due to `posix_spawnp failed` on macOS + Node 24.
- Frontend is a monolithic `public/index.html` (CSS + HTML + JS in one file).
