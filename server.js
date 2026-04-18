// ไฟล์: server.js (Interactive Claude CLI via node-pty)
// รันด้วยคำสั่ง: node server.js
// เปิดเว็บ: http://localhost:3003

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const activeSessions = new Map();
let currentProjectPath = process.cwd();

// SQLite setup
const db = new Database(path.join(__dirname, 'chat.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    title TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
`);

function ensureSession(sessionId, projectPath) {
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!existing) {
    db.prepare('INSERT INTO sessions (id, project_path, title) VALUES (?, ?, ?)').run(sessionId, projectPath, 'New Chat');
  }
}

function saveMessage(sessionId, role, content) {
  db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(sessionId, role, content);
}

function getHistory(sessionId, limit = 200) {
  return db.prepare(
    'SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
  ).all(sessionId, limit);
}

function updateSessionTitle(sessionId, title) {
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title.slice(0, 100), sessionId);
}

function getSessions() {
  return db.prepare(
    'SELECT id, title, created_at FROM sessions ORDER BY created_at DESC LIMIT 50'
  ).all();
}

function deleteSession(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function isSafePath(projectPath, targetPath) {
  const resolved = path.resolve(projectPath, targetPath);
  return resolved.startsWith(path.resolve(projectPath));
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({
    type: 'system',
    data: {
      projectPath: currentProjectPath,
      projectName: path.basename(currentProjectPath),
      nodeVersion: process.version,
      platform: process.platform
    }
  }));

  ws.on('message', (msg) => {
    try {
      const text = Buffer.isBuffer(msg) ? msg.toString('utf8') : msg;
      const data = JSON.parse(text);
      handleMessage(ws, data);
    } catch (e) {
      console.error('JSON parse error:', e.message, 'raw:', msg.toString ? msg.toString() : msg);
      ws.send(JSON.stringify({ type: 'error', data: { message: 'รูปแบบข้อมูลไม่ถูกต้อง' } }));
    }
  });

  ws.on('close', () => {
    for (const [id, session] of activeSessions) {
      if (session.process) {
        if (session.isPTY) session.process.kill();
        else session.process.kill();
      }
    }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function handleMessage(ws, data) {
  const projectPath = data.projectPath || currentProjectPath;

  switch (data.type) {
    case 'chat': handleChat(ws, data, projectPath); break;
    case 'terminal': handleTerminal(ws, data, projectPath); break;
    case 'read_file': handleReadFile(ws, data, projectPath); break;
    case 'write_file': handleWriteFile(ws, data, projectPath); break;
    case 'list_files': handleListFiles(ws, data, projectPath); break;
    case 'stop': handleStop(ws, data); break;
    case 'pty_input': handlePTYInput(ws, data); break;
    case 'pty_resize': handlePTYResize(ws, data); break;
    case 'load_history': handleLoadHistory(ws, data); break;
    case 'list_sessions': handleListSessions(ws, data, projectPath); break;
    case 'delete_session': handleDeleteSession(ws, data); break;
    case 'choose_folder': handleChooseFolder(ws); break;
    case 'set_project': handleSetProject(ws, data); break;
    default: ws.send(JSON.stringify({ type: 'error', data: { message: `ไม่รู้จักคำสั่ง: ${data.type}` } }));
  }
}

function handleChooseFolder(ws) {
  let cmd, args;
  if (process.platform === 'darwin') {
    cmd = 'osascript';
    args = ['-e', 'tell application "Finder" to activate', '-e', 'tell application "Finder" to POSIX path of (choose folder with prompt "Select project folder")'];
  } else if (process.platform === 'win32') {
    cmd = 'powershell.exe';
    args = ['-Command', 'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = "Select project folder"; $f.ShowDialog() | Out-Null; $f.SelectedPath'];
  } else {
    // Linux - try zenity first, then kdialog
    cmd = 'sh';
    args = ['-c', 'zenity --file-selection --directory 2>/dev/null || kdialog --getexistingdirectory "" 2>/dev/null || echo ""'];
  }
  
  const proc = spawn(cmd, args, { shell: false });
  let output = '';
  proc.stdout.on('data', chunk => { output += chunk.toString(); });
  proc.on('close', code => {
    const chosen = output.trim().replace(/\n/g, '');
    if (chosen && fs.existsSync(chosen)) {
      ws.send(JSON.stringify({ type: 'folder_selected', data: { path: chosen } }));
    } else {
      ws.send(JSON.stringify({ type: 'folder_cancelled', data: {} }));
    }
  });
  proc.on('error', () => {
    ws.send(JSON.stringify({ type: 'error', data: { message: 'Could not open folder dialog. Please type the path manually.' } }));
  });
}

function handleSetProject(ws, data) {
  const newPath = data.path;
  if (!newPath || !fs.existsSync(newPath)) {
    return ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid project path: ' + newPath } }));
  }
  currentProjectPath = path.resolve(newPath);
  // Broadcast to all connected clients
  const msg = JSON.stringify({
    type: 'system',
    data: {
      projectPath: currentProjectPath,
      projectName: path.basename(currentProjectPath),
      nodeVersion: process.version,
      platform: process.platform
    }
  });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function buildContextPrompt(sessionId, currentMessage, mode = 'chat', maxChars = 30000) {
  const rows = getHistory(sessionId, 50);
  
  let modePrefix = '';
  if (mode === 'code') {
    modePrefix = 'You are a code assistant. Provide concise, working code with minimal explanation unless asked. Use comments sparingly. Prefer complete, copy-paste ready solutions.\n\n';
  }
  
  if (!rows || rows.length <= 1) return modePrefix + currentMessage;
  
  // Remove the last entry which is the current user message just saved
  const past = rows.slice(0, -1).filter(r => r.content && r.content.trim().length > 0);
  if (past.length === 0) return modePrefix + currentMessage;
  
  let context = modePrefix;
  for (const row of past) {
    const label = row.role === 'user' ? 'Human' : row.role === 'assistant' ? 'Assistant' : 'System';
    context += `${label}: ${row.content}\n`;
  }
  context += `\nHuman: ${currentMessage}\n\nAssistant:`;
  
  if (context.length > maxChars) {
    const recent = past.slice(-20);
    context = modePrefix;
    for (const row of recent) {
      const label = row.role === 'user' ? 'Human' : row.role === 'assistant' ? 'Assistant' : 'System';
      context += `${label}: ${row.content}\n`;
    }
    context += `\nHuman: ${currentMessage}\n\nAssistant:`;
  }
  
  console.log('[CONTEXT PROMPT length]', context.length, 'past messages:', past.length, 'mode:', mode);
  return context;
}

function handleChat(ws, data, projectPath) {
  const sessionId = data.sessionId || 'default';
  const session = activeSessions.get(sessionId);
  
  // Save user message
  if (data.message && data.message.trim()) {
    ensureSession(sessionId, projectPath);
    saveMessage(sessionId, 'user', data.message.trim());
    // Auto-update title from first user message
    const count = db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId).c;
    if (count === 1) {
      updateSessionTitle(sessionId, data.message.trim().slice(0, 60));
    }
  }
  
  // If PTY session exists, send input to it
  if (session && session.isPTY && session.process) {
    session.process.write(data.message + '\r');
    return;
  }

  // Start PTY mode if requested
  if (data.mode === 'pty') {
    return startPTY(ws, data, projectPath);
  }

  // Otherwise fallback to print mode
  if (activeSessions.has(sessionId)) {
    activeSessions.get(sessionId).process?.kill();
  }

  ws.send(JSON.stringify({ type: 'status', data: { status: 'starting', message: 'กำลังเรียก Claude...' } }));

  const prompt = buildContextPrompt(sessionId, data.message || '', data.mode || 'chat');
  const cliCmd = process.env.CLAUDE_CMD || 'claude';
  const proc = spawn(cliCmd, ['--print', prompt], {
    cwd: projectPath,
    env: { ...process.env, FORCE_COLOR: '0', CLICOLOR_FORCE: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let buffer = '';
  proc.stdout.on('data', chunk => {
    const text = chunk.toString();
    buffer += text;
    ws.send(JSON.stringify({ type: 'stream', data: { text, sessionId } }));
  });

  proc.stderr.on('data', chunk => {
    ws.send(JSON.stringify({ type: 'stderr', data: { text: chunk.toString(), sessionId } }));
  });

  proc.on('error', err => {
    ws.send(JSON.stringify({ type: 'error', data: { message: `เรียก Claude ไม่ได้: ${err.message}\nตรวจสอบ: npm install -g @anthropic-ai/claude-code`, hint: 'ติดตั้ง CLI หรือตั้งค่า CLAUDE_CMD ใน environment' } }));
  });

  proc.on('close', code => {
    activeSessions.delete(sessionId);
    saveMessage(sessionId, 'assistant', buffer);
    ws.send(JSON.stringify({ type: 'complete', data: { output: buffer, code, sessionId } }));
  });

  activeSessions.set(sessionId, { process: proc, ws, isPTY: false });
}

function startPTY(ws, data, projectPath) {
  const sessionId = data.sessionId || 'default';
  
  if (activeSessions.has(sessionId)) {
    const old = activeSessions.get(sessionId);
    if (old.process) old.process.kill();
  }

  ws.send(JSON.stringify({ type: 'status', data: { status: 'starting', message: 'กำลังเปิด Claude Interactive...' } }));

  const cliCmd = process.env.CLAUDE_CMD || 'claude';
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
  
  // Start a shell and run claude inside it
  const proc = pty.spawn(shell, ['-c', cliCmd], {
    name: 'xterm-color',
    cols: data.cols || 80,
    rows: data.rows || 24,
    cwd: projectPath,
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' }
  });

  proc.onData(chunk => {
    ws.send(JSON.stringify({ type: 'pty_output', data: { text: chunk, sessionId } }));
  });

  proc.onExit(({ exitCode, signal }) => {
    activeSessions.delete(sessionId);
    ws.send(JSON.stringify({ type: 'pty_exit', data: { code: exitCode, signal, sessionId } }));
  });

  activeSessions.set(sessionId, { process: proc, ws, isPTY: true });
  ws.send(JSON.stringify({ type: 'pty_ready', data: { sessionId } }));
}

function handlePTYInput(ws, data) {
  const sessionId = data.sessionId || 'default';
  const session = activeSessions.get(sessionId);
  if (session && session.isPTY && session.process) {
    session.process.write(data.input);
  }
}

function handlePTYResize(ws, data) {
  const sessionId = data.sessionId || 'default';
  const session = activeSessions.get(sessionId);
  if (session && session.isPTY && session.process) {
    session.process.resize(data.cols || 80, data.rows || 24);
  }
}

function handleTerminal(ws, data, projectPath) {
  const cmd = data.command;
  ws.send(JSON.stringify({ type: 'terminal_status', data: { status: 'running', command: cmd } }));

  const proc = spawn(cmd, [], { shell: true, cwd: projectPath, env: { ...process.env } });

  proc.stdout.on('data', c => ws.send(JSON.stringify({ type: 'terminal_output', data: { text: c.toString(), command: cmd } })));
  proc.stderr.on('data', c => ws.send(JSON.stringify({ type: 'terminal_error', data: { text: c.toString(), command: cmd } })));
  proc.on('close', c => ws.send(JSON.stringify({ type: 'terminal_complete', data: { code: c, command: cmd } })));
  proc.on('error', e => ws.send(JSON.stringify({ type: 'terminal_error', data: { text: e.message, command: cmd } })));
}

function handleReadFile(ws, data, projectPath) {
  if (!isSafePath(projectPath, data.path)) {
    return ws.send(JSON.stringify({ type: 'file_error', data: { path: data.path, error: 'เข้าถึงพาธนอกโปรเจกต์ไม่ได้' } }));
  }
  try {
    const fullPath = path.resolve(projectPath, data.path);
    const content = fs.readFileSync(fullPath, 'utf8');
    const stat = fs.statSync(fullPath);
    ws.send(JSON.stringify({
      type: 'file_content',
      data: {
        path: data.path,
        content,
        size: stat.size,
        mtime: stat.mtimeMs,
        mode: (stat.mode & parseInt('777', 8)).toString(8)
      }
    }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'file_error', data: { path: data.path, error: e.message } }));
  }
}

function handleWriteFile(ws, data, projectPath) {
  if (!isSafePath(projectPath, data.path)) {
    return ws.send(JSON.stringify({ type: 'file_error', data: { path: data.path, error: 'เข้าถึงพาธนอกโปรเจกต์ไม่ได้' } }));
  }
  try {
    const fullPath = path.resolve(projectPath, data.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data.content, 'utf8');
    ws.send(JSON.stringify({ type: 'file_written', data: { path: data.path } }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'file_error', data: { path: data.path, error: e.message } }));
  }
}

function handleListFiles(ws, data, projectPath) {
  const target = data.path ? path.resolve(projectPath, data.path) : projectPath;
  if (!target.startsWith(path.resolve(projectPath))) {
    return ws.send(JSON.stringify({ type: 'file_error', data: { error: 'เข้าถึงพาธนอกโปรเจกต์ไม่ได้' } }));
  }
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const files = entries.map(e => {
      const stat = fs.statSync(path.join(target, e.name));
      return {
        name: e.name,
        isDirectory: e.isDirectory(),
        path: path.join(data.path || '', e.name),
        size: stat.size,
        mtime: stat.mtimeMs
      };
    });
    files.sort((a, b) => (a.isDirectory === b.isDirectory) ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1));
    ws.send(JSON.stringify({ type: 'file_list', data: { path: data.path || '.', files } }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'file_error', data: { error: e.message } }));
  }
}

function handleStop(ws, data) {
  const session = activeSessions.get(data.sessionId || 'default');
  if (session?.process) {
    session.process.kill();
    ws.send(JSON.stringify({ type: 'stopped', data: { sessionId: data.sessionId || 'default' } }));
  }
}

function handleLoadHistory(ws, data) {
  const sessionId = data.sessionId || 'default';
  const rows = getHistory(sessionId, data.limit || 200);
  ws.send(JSON.stringify({ type: 'history', data: { sessionId, messages: rows } }));
}

function handleListSessions(ws, data) {
  const rows = getSessions();
  ws.send(JSON.stringify({ type: 'sessions', data: { sessions: rows } }));
}

function handleDeleteSession(ws, data) {
  deleteSession(data.sessionId);
  ws.send(JSON.stringify({ type: 'session_deleted', data: { sessionId: data.sessionId } }));
}

const PORT = process.env.PORT || 3003;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ เซิร์ฟเวอร์พร้อมใช้งาน\n🌐 http://localhost:${PORT}\n📁 ${process.cwd()}\n🛑 กด Ctrl+C เพื่อหยุด`);
});
