# Session Handoff — Claude Code Web UI

> ไฟล์นี้สรุปสถานะล่าสุดของโปรเจกต์ สำหรับ session ใหม่ที่มาทำต่อ

## ✅ เสร็จแล้ว (Completed)

### Phase 1: Chat Mode — Core Stability
- [x] **Context-aware Print Mode** — `buildContextPrompt()` ใช้ `Human:/Assistant:` format + `slice(0,-1)` ส่ง context ย้อนหลัง 20-50 turns ให้ Claude CLI
- [x] **Session History Sidebar** — sidebar มี section "History" แสดง session list, click-to-load, hover delete
- [x] **Message Rendering** — รองรับ bullet lists, numbered lists, links `[text](url)`, blockquotes `>`, italic `*text*`, bold `**text**`, code blocks, inline code
- [x] **Code Mode** — ปุ่ม Code/Chat บน input bar ส่ง mode ไป backend, Code mode prepend prompt ด้วย "You are a code assistant..."
- [x] **Stop/Cancel Reliability** — `resetUI()` รวมการ reset ปุ่ม + typing indicator + `procRun` ไว้จุดเดียว

### Phase 3: UI/UX Polish
- [x] **File Tree Navigation** — click folder เข้าไปได้, breadcrumb, ปุ่ม `..` กลับ, แสดง size + mtime
- [x] **File Modal** — click ไฟล์เปิด Modal ดูเนื้อหา พร้อม line numbers, copy button, edit mode, save (write_file)
- [x] **Mobile Input** — visual viewport handling, auto-scroll เมื่อ focus textarea
- [x] **Theme Toggle** — Dark/Light/Auto ใน Settings, จำใน localStorage, รองรับ `prefers-color-scheme`

### Bonus Features
- [x] **Open Project Folder** — ปุ่ม Open บน topbar, เปิด native file dialog (osascript/zenity/PowerShell), broadcast เปลี่ยน project path ไปทุก client
- [x] **Multi-turn context verified** — ทดสอบ "My name is John" → "What is my name?" ผ่าน

## ⏳ ค้างอยู่ (Pending / Next Up)

### Phase 2: PTY Interactive Mode (Priority: MEDIUM)
- [ ] **PTY Stability** — `node-pty` บน macOS + Node 24 มีปัญหาเสถียรภาพ (heartbeat timeout, unexpected exit)
- [ ] **PTY Keyboard Focus** — Ctrl+C ต้องส่ง `\x03` ไป PTY ไม่ใช่ browser copy
- [ ] **PTY Session Persistence** — บันทึก raw PTY output เป็น text file ต่อ session
- [ ] **PTY Retry Logic** — ถ้า PTY ตายภายใน 3 วินาที แสดง error และแนะนำ Chat mode

### Phase 4: Multi-Provider Support (Priority: LOW)
- [ ] **Provider Switcher** — dropdown ใน Settings เลือกระหว่าง `claude`, `kimi`, หรือ custom CLI path
- [ ] **Backend Provider Routing** — ใช้ `data.provider || process.env.CLAUDE_CMD || 'claude'` เมื่อ spawn

## 🏗️ Architecture

```
public/index.html  — Single-page frontend (CSS + HTML + JS อยู่ในไฟล์เดียว)
server.js          — Express + WebSocket backend
chat.db            — SQLite (sessions + messages)
```

### WebSocket Message Types
| Type | Direction | ใช้ทำอะไร |
|------|-----------|----------|
| `chat` | C→S | ส่งข้อความไป Claude (Print mode) |
| `terminal` | C→S | รัน shell command |
| `read_file` | C→S | อ่านไฟล์ |
| `write_file` | C→S | เขียน/แก้ไขไฟล์ |
| `list_files` | C→S | list directory |
| `choose_folder` | C→S | เปิด native file dialog |
| `set_project` | C→S | เปลี่ยน project path |
| `load_history` | C→S | โหลด chat history |
| `list_sessions` | C→S | list sessions |
| `delete_session` | C→S | ลบ session |
| `system` | S→C | ส่ง project info, node version, platform |
| `stream` | S→C | Claude ตอบกลับทีละ chunk |
| `complete` | S→C | Claude ตอบเสร็จ |
| `file_content` | S→C | เนื้อหาไฟล์ + metadata |
| `file_list` | S→C | รายการไฟล์ + stats |
| `folder_selected` | S→C | path ที่เลือกจาก dialog |
| `history` | S→C | รายการ messages |
| `sessions` | S→C | รายการ sessions |

## ⚠️ Known Issues
- **Background task kill**: ห้ามรัน `node server.js` ผ่าน background task (จะโดน kill จาก heartbeat timeout) → รันใน terminal ตรงๆ เท่านั้น
- **node-pty version**: ติด `0.10.1` เท่านั้น (`1.1.0` มีปัญหา `posix_spawnp failed` บน macOS + Node 24)

## 🚀 Quick Commands
```bash
# Start server
cd /Users/alone/AiCode/claudecode-web && node server.js

# Kill old server on port 3003
lsof -i :3003 | grep LISTEN | awk '{print $2}' | xargs kill -9

# Open in browser
open http://localhost:3003
```

## 📁 Git Status
Branch: `interactive-claude`
Remote: `https://github.com/Endlessedwork/claudecode-web`
