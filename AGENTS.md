# Claude Code Web UI — Agent Guide

> **For AI coding agents:** This file documents everything you need to know to work on this project. Read `SESSION_HANDOFF.md` first for the current sprint status, completed features, and pending tasks.

---

## Project Overview

Claude Code Web UI is a web-based interface for interacting with Claude Code CLI (and potentially other CLI tools) through a browser. It provides chat, file management, terminal execution, and an interactive PTY mode — all backed by the real CLI running on the host machine.

The project is intentionally minimal: a single Node.js backend file and a single-page frontend with no build step, no bundler, and no frontend framework.

**Repository:** `https://github.com/Endlessedwork/claudecode-web`  
**Branch:** `interactive-claude`

---

## Technology Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js (tested on macOS + Node 24) |
| Backend | Express 4.x, WebSocket (`ws` 8.x), `node-pty@0.10.1`, `better-sqlite3` |
| Frontend | Vanilla JS, CSS custom properties, inline HTML (single file) |
| Terminal | xterm.js 5.3.0 + xterm-addon-fit 0.8.0 (loaded from CDN) |
| Font | Inter (Google Fonts) |
| Database | SQLite (`chat.db`) |
| Icons | Heroicons SVG (inline, no icon library) |

---

## Project Structure

```
claudecode-web/
├── server.js              # Express + WebSocket backend (~800 lines)
├── public/
│   └── index.html         # Single-page frontend (~1600 lines, CSS+HTML+JS)
├── mock-claude.js         # Mock CLI for testing NDJSON stream output
├── chat.db                # SQLite database (sessions + messages)
├── pty-logs/              # PTY session raw output logs
├── design-system/
│   └── claude-code-web-ui/
│       └── MASTER.md      # Design system specs (colors, spacing, components)
├── SESSION_HANDOFF.md     # Current sprint status & architecture notes
├── package.json           # Dependencies & start script
└── AGENTS.md              # This file
```

**No build step.** The frontend is served as static files by Express. `public/index.html` contains all CSS and JS inline.

---

## Build and Run Commands

```bash
# Install dependencies
npm install

# Start the server (MUST run in foreground — see Known Issues)
node server.js
# or
npm start

# Default URL
open http://localhost:3003

# Kill a stale server on port 3003
lsof -i :3003 | grep LISTEN | awk '{print $2}' | xargs kill -9
```

**Environment Variables:**
- `PORT` — server port (default: `3003`)
- `CLAUDE_CMD` — override Claude CLI command path (default: `claude`)
- `KIMI_CMD` — override Kimi CLI command path (default: `kimi`)

---

## Architecture

### Backend (`server.js`)

The server exposes:
1. **HTTP static server** — serves `public/index.html` for all non-API routes (SPA fallback)
2. **WebSocket server** — handles all real-time communication

**WebSocket Message Types (C→S):**
| Type | Purpose |
|------|---------|
| `chat` | Send message to AI CLI (Print or PTY mode) |
| `terminal` | Execute a shell command |
| `read_file` | Read a file within the project path |
| `write_file` | Write a file within the project path |
| `list_files` | List directory contents |
| `choose_folder` | Open native file picker (osascript/zenity/PowerShell) |
| `set_project` | Change the working project path |
| `load_history` | Load chat history for a session |
| `list_sessions` | List persisted chat sessions |
| `delete_session` | Delete a session |
| `list_claude_sessions` | List native Claude CLI sessions from `~/.claude/projects/` |
| `load_claude_session` | Load a native Claude session JSONL |
| `save_message` | Persist a system message |
| `stop` | Kill the active subprocess |
| `pty_input` | Send keystrokes to the PTY |
| `pty_resize` | Resize the PTY terminal |

**Key Backend Modules:**
- **Chat/Print Mode:** Spawns `claude --print --output-format stream-json` (or custom provider). Parses NDJSON output, captures `session_id` for resume, streams text/thinking/result events to the client.
- **PTY Interactive Mode:** Spawns a shell via `node-pty`, runs the CLI inside it, connects to xterm.js. Includes health check (5s), log persistence to `pty-logs/`, and early-exit detection (<3s).
- **File Ops:** Path traversal is guarded by `isSafePath()` — only paths inside the current project directory are allowed.
- **Session Persistence:** SQLite (`chat.db`) stores sessions and messages. Also reads native Claude sessions from `~/.claude/projects/<encoded-path>/*.jsonl`.

### Frontend (`public/index.html`)

A monolithic SPA with inline CSS and JS. Pages/views:
- **Chat** — Main chat interface with streaming responses, event logs, thinking blocks
- **Files** — File tree browser with breadcrumb navigation, file modal (view/edit)
- **Terminal** — Simple command execution output
- **Interactive (PTY)** — Full xterm.js terminal connected to Claude CLI PTY
- **Settings** — Provider switcher, custom CLI path, theme toggle, project path

**Key Frontend Behaviors:**
- WebSocket auto-reconnect with exponential backoff (max 20s)
- Client-side routing via `history.pushState` (`/chat/:sid`, `/files`, `/term`, `/pty`, `/settings`)
- Slash commands: `/clear`, `/help`, `/run`, `/read`, `/write`, `/git`, `/npm`, `/node`, `/ls`, `/cat`, `/mkdir`, `/rm`, `/cp`, `/mv`, `/pwd`, `/echo`, `/touch`, `/whoami`, `/which`, `/uname`, `/list`
- Chat modes: `chat` (default) and `code` (prepends code-assistant prompt)
- Themes: Dark / Light / Auto (persisted in `localStorage`)
- Providers: `claude` (default), `kimi`, `custom`, `mock`

---

## Code Style Guidelines

- **Backend:** Uses `require()`, plain Node.js. No TypeScript, no linter configured.
- **Frontend:** Vanilla JS (ES6+), no frameworks. CSS uses BEM-like naming (e.g., `.input-bar__field`, `.page-chat__messages`).
- **Comments:** Inline comments in `server.js` and some UI labels are written in **Thai**. Error messages are often bilingual (Thai + English). New code should match the existing comment language where adjacent.
- **Variable naming:** Backend uses camelCase. Frontend uses a mix: `$` for DOM getter, short abbreviations for frequent elements (`$('inp')`, `$('msgs')`).
- **No emojis as icons** per design system — use inline SVG (Heroicons paths).
- **CSS:** CSS custom properties for theming. Transitions are 120–200ms. Responsive breakpoints at `768px` (tablet) and `1280px` (desktop).

---

## Testing

There is no formal test framework. Testing is done via:
1. **Mock Provider** — Select "[Test] Mock" in Settings. This runs `mock-claude.js`, which simulates NDJSON stream events (system hooks, assistant thinking + text blocks, result event with cost).
2. **Manual verification** — Common smoke tests include:
   - Multi-turn context: "My name is John" → "What is my name?"
   - File read/write via slash commands
   - PTY start/stop/restart cycle
   - Theme switch and sidebar collapse persistence

---

## Security Considerations

- **Path traversal protection:** `isSafePath(projectPath, targetPath)` resolves and checks `startsWith(path.resolve(projectPath))` for all file read/write/list operations.
- **No authentication:** The server binds to `0.0.0.0` and accepts any WebSocket connection. Do not expose to untrusted networks.
- **Shell injection:** The `terminal` handler uses `shell: true` with raw user input. This is intentional (power user tool), but treat the instance as having the privileges of the user running `node server.js`.
- **Native file dialog:** `choose_folder` spawns platform-specific scripts (`osascript`, `zenity`, `PowerShell`). These are hardcoded and do not execute user input.

---

## Known Issues & Constraints

1. **Do NOT run as a background task** — The server will be killed by WebSocket heartbeat timeout if launched via background bash. Always run directly in an interactive terminal.
2. **`node-pty` version lock** — Pinned to `0.10.1`. Version `1.1.0` causes `posix_spawnp failed` on macOS with Node 24.
3. **PTY stability on macOS** — Interactive mode can crash unexpectedly. There is a 5-second health check and early-exit retry logic that recommends Chat mode if PTY dies within 3 seconds.
4. **Frontend monolith** — All CSS and JS live in `public/index.html`. For small changes, edit inline. For larger changes, consider extracting modules while keeping the zero-build architecture.
5. **No npm build / no bundler** — Changes to frontend code are effective immediately on browser refresh.
6. **SQLite migrations** — The backend auto-detects missing columns (e.g., `claude_session_id`) and runs `ALTER TABLE` on startup. No migration framework is used.

---

## Design System Reference

See `design-system/claude-code-web-ui/MASTER.md` for:
- Color palette (`#1E293B` primary, `#22C55E` CTA, `#0F172A` background)
- Typography (Inter, weights 300–700)
- Spacing tokens (`--space-xs` to `--space-3xl`)
- Component specs (buttons, cards, inputs, modals)
- Anti-patterns (no emojis as icons, always `cursor:pointer`, visible focus states)

When building a specific page, check `design-system/pages/[page-name].md` — if it exists, its rules override the Master file.

---

## Quick Reference: Adding a New WebSocket Handler

1. **Backend:** Add a `case` in `handleMessage()` and implement `handleYourFeature(ws, data, projectPath)`.
2. **Frontend:** Add a handler in `handleMsg()` switch block under `// message types`.
3. Use `safeSend({type:'your_type',...})` on the client and `ws.send(JSON.stringify({type:'your_type',data:{...}}))` on the server.
4. Keep messages small — the frontend renders in real time.

---

*Last updated: 2026-04-16*  
*If you are starting a new session, read `SESSION_HANDOFF.md` first for the latest sprint status.*
