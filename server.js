// ไฟล์: server.js (Interactive Claude CLI via node-pty)
// รันด้วยคำสั่ง: node server.js
// เปิดเว็บ: http://localhost:3003

const express = require('express');
const http = require('http');
const https = require('https');
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

// SPA fallback: serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const activeSessions = new Map();
let currentProjectPath = process.cwd();
const PTY_LOG_DIR = path.join(__dirname, 'pty-logs');
if (!fs.existsSync(PTY_LOG_DIR)) fs.mkdirSync(PTY_LOG_DIR, { recursive: true });

const CLAUDE_DATA_DIR = path.join(require('os').homedir(), '.claude');

function encodeClaudeProjectPath(projectPath) {
  return projectPath.replace(/\//g, '-');
}

function getClaudeProjectDir(projectPath) {
  const encoded = encodeClaudeProjectPath(projectPath);
  return path.join(CLAUDE_DATA_DIR, 'projects', encoded);
}

function getClaudeSessions(projectPath) {
  const dir = getClaudeProjectDir(projectPath);
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error('[Claude Sessions] readdir error:', e.message);
    return [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -6); // remove .jsonl
    const filePath = path.join(dir, entry.name);
    const stat = fs.statSync(filePath);
    // Try to get title from first user message
    let title = sessionId.slice(0, 8) + '...';
    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
      fs.closeSync(fd);
      const chunk = buffer.toString('utf8', 0, bytesRead);
      const lines = chunk.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' && obj.message?.content) {
            const text = typeof obj.message.content === 'string'
              ? obj.message.content
              : JSON.stringify(obj.message.content).slice(0, 60);
            title = text.slice(0, 60);
            break;
          }
          if (obj.type === 'queue-operation' && obj.content) {
            title = obj.content.slice(0, 60);
            break;
          }
        } catch (e) {}
      }
    } catch (e) {}
    sessions.push({
      id: sessionId,
      title,
      mtime: stat.mtimeMs,
      size: stat.size
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

function loadClaudeSession(projectPath, sessionId, maxLines = 500) {
  const dir = getClaudeProjectDir(projectPath);
  const filePath = path.join(dir, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const allLines = content.split('\n').filter(l => l.trim());
  const lines = allLines.slice(-maxLines); // take last N lines to avoid huge files
  const messages = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && obj.message?.content) {
        const text = typeof obj.message.content === 'string'
          ? obj.message.content
          : JSON.stringify(obj.message.content);
        messages.push({ role: 'user', content: text, timestamp: obj.timestamp });
      } else if (obj.type === 'assistant' && obj.message?.content) {
        let text = '';
        if (typeof obj.message.content === 'string') {
          text = obj.message.content;
        } else if (Array.isArray(obj.message.content)) {
          text = obj.message.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
        }
        if (text) messages.push({ role: 'assistant', content: text, timestamp: obj.timestamp });
      }
    } catch (e) {}
  }
  return { sessionId, messages };
}

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

// Migrate: add claude_session_id column if not exists
const hasColumn = db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info('sessions') WHERE name = 'claude_session_id'`).get().c;
if (hasColumn === 0) {
  db.exec(`ALTER TABLE sessions ADD COLUMN claude_session_id TEXT`);
  console.log('[DB] Migrated: added claude_session_id column');
}

function ensureSession(sessionId, projectPath) {
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!existing) {
    db.prepare('INSERT INTO sessions (id, project_path, title) VALUES (?, ?, ?)').run(sessionId, projectPath, 'New Chat');
  }
}

function getClaudeSessionId(sessionId) {
  const row = db.prepare('SELECT claude_session_id FROM sessions WHERE id = ?').get(sessionId);
  return row ? row.claude_session_id : null;
}

function updateClaudeSessionId(sessionId, claudeSessionId) {
  if (!claudeSessionId) return;
  db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, sessionId);
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
      console.log('[WS RAW]', text.slice(0, 200));
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
    case 'list_claude_sessions': handleListClaudeSessions(ws, data, projectPath); break;
    case 'load_claude_session': handleLoadClaudeSession(ws, data, projectPath); break;
    case 'save_message': handleSaveMessage(ws, data, projectPath); break;
    case 'kimi_api_chat': handleKimiAPIChat(ws, data, projectPath); break;
    default: ws.send(JSON.stringify({ type: 'error', data: { message: `ไม่รู้จักคำสั่ง: ${data.type}` } }));
  }
}

function handleListClaudeSessions(ws, data, projectPath) {
  try {
    const sessions = getClaudeSessions(projectPath);
    ws.send(JSON.stringify({ type: 'claude_sessions', data: { sessions, projectPath } }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', data: { message: 'Failed to list Claude sessions: ' + e.message } }));
  }
}

function handleLoadClaudeSession(ws, data, projectPath) {
  try {
    const result = loadClaudeSession(projectPath, data.sessionId, data.limit || 500);
    if (!result) {
      return ws.send(JSON.stringify({ type: 'error', data: { message: 'Session not found: ' + data.sessionId } }));
    }
    ws.send(JSON.stringify({ type: 'claude_session_content', data: result }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', data: { message: 'Failed to load Claude session: ' + e.message } }));
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

function resolveCliCommand(provider, customCmd, isPTY) {
  switch (provider) {
    case 'mock': return 'node';
    case 'kimi': {
      const kimiDir = '/Users/alone/.local/share/uv/tools/kimi-cli';
      return isPTY ? `cd ${kimiDir} && bin/python3 -m kimi_cli term` : `cd ${kimiDir} && bin/python3 -m kimi_cli`;
    }
    case 'custom': return customCmd || process.env.CLAUDE_CMD || 'claude';
    case 'claude':
    default: return process.env.CLAUDE_CMD || 'claude';
  }
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

  const providerLabel = data.provider && data.provider !== 'claude' ? data.provider : 'Claude';
  ws.send(JSON.stringify({ type: 'status', data: { status: 'starting', message: `กำลังเรียก ${providerLabel}...` } }));

  const cliCmd = resolveCliCommand(data.provider, data.customCmd);
  const isClaude = !data.provider || data.provider === 'claude' || data.provider === 'mock';
  
  // For Claude CLI, use stream-json mode with resume
  let claudeSessionId = null;
  let prompt;
  let args, env;
  if (data.provider === 'mock') {
    // Mock provider: run local mock script
    prompt = data.message || 'Hello';
    args = [path.join(__dirname, 'mock-claude.js'), prompt];
    env = { ...process.env };
  } else if (isClaude) {
    claudeSessionId = getClaudeSessionId(sessionId);
    if (claudeSessionId) {
      // If we have a Claude session ID, just send the new message (resume handles context)
      prompt = data.message || '';
    } else {
      // No Claude session yet, build context from our DB
      prompt = buildContextPrompt(sessionId, data.message || '', data.mode || 'chat');
    }
    args = ['--print', '--output-format', 'stream-json'];
    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    }
    args.push(prompt);
    env = { ...process.env };
  } else {
    // Non-Claude: use traditional context prompt
    prompt = buildContextPrompt(sessionId, data.message || '', data.mode || 'chat');
    args = ['--print', prompt];
    env = { ...process.env, FORCE_COLOR: '0', CLICOLOR_FORCE: '0' };
  }
  
  const proc = spawn(cliCmd, args, {
    cwd: projectPath,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let buffer = '';
  let streamBuffer = ''; // for NDJSON line buffering
  let capturedClaudeSessionId = claudeSessionId;
  
  function safeSendWS(obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error('[WS send error]', e.message, 'object keys:', Object.keys(obj));
    }
  }

  proc.stdout.on('data', chunk => {
    const text = chunk.toString();
    
    if (isClaude && !capturedClaudeSessionId) {
      // Try to capture session_id from first chunk
      const m = text.match(/"session_id"\s*:\s*"([^"]+)"/);
      if (m && m[1]) {
        capturedClaudeSessionId = m[1];
        updateClaudeSessionId(sessionId, capturedClaudeSessionId);
        safeSendWS({ type: 'claude_session_linked', data: { sessionId, claudeSessionId: capturedClaudeSessionId } });
      }
    }
    
    if (isClaude) {
      // Parse NDJSON stream
      streamBuffer += text;
      let lines = streamBuffer.split('\n');
      streamBuffer = lines.pop(); // keep incomplete line for next chunk
      console.log('[NDJSON] lines to parse:', lines.length, 'buffer remaining:', streamBuffer.length);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          console.log('[NDJSON] parsed event type:', event.type, '| keys:', Object.keys(event).join(','));
          // Forward structured events to client
          if (event.type === 'assistant' && event.message?.content) {
            const blocks = Array.isArray(event.message.content)
              ? event.message.content
              : [{ type: 'text', text: event.message.content }];
            for (const block of blocks) {
              if (block.type === 'text' && block.text) {
                buffer += block.text;
                safeSendWS({ type: 'stream', data: { text: block.text, sessionId } });
              } else if (block.type === 'thinking' && block.thinking) {
                safeSendWS({ type: 'stream_event', data: { event: 'thinking', text: block.thinking, raw: line, sessionId } });
              }
            }
          } else if (event.type === 'result') {
            // Sanitize usage to avoid circular refs or huge objects
            let usageStr = null;
            try { usageStr = event.usage ? JSON.stringify(event.usage).slice(0, 2000) : null; } catch(e) {}
            safeSendWS({ type: 'stream_event', data: { event: 'result', result: event.result, usage: usageStr, cost: event.total_cost_usd, raw: line, sessionId } });
          } else if (event.type === 'error') {
            safeSendWS({ type: 'stream_event', data: { event: 'error', error: event.error || event.message, raw: line, sessionId } });
          } else {
            // Forward all other events as raw for debug view
            safeSendWS({ type: 'stream_event', data: { event: event.type, raw: line, sessionId } });
          }
          // Capture session_id from any event if not yet captured
          if (!capturedClaudeSessionId && event.session_id) {
            capturedClaudeSessionId = event.session_id;
            updateClaudeSessionId(sessionId, capturedClaudeSessionId);
            safeSendWS({ type: 'claude_session_linked', data: { sessionId, claudeSessionId: capturedClaudeSessionId } });
          }
        } catch (e) {
          console.log('[NDJSON] parse failed:', e.message, 'line:', line.slice(0, 100));
          // Not valid JSON, ignore or send as plain text for backward compat
          safeSendWS({ type: 'stream', data: { text: line + '\n', sessionId } });
        }
      }
    } else {
      // Non-Claude provider: plain text mode
      buffer += text;
      safeSendWS({ type: 'stream', data: { text, sessionId } });
    }
  });

  proc.stderr.on('data', chunk => {
    safeSendWS({ type: 'stderr', data: { text: chunk.toString(), sessionId } });
  });

  proc.on('error', err => {
    safeSendWS({ type: 'error', data: { message: `เรียก Claude ไม่ได้: ${err.message}\nตรวจสอบ: npm install -g @anthropic-ai/claude-code`, hint: 'ติดตั้ง CLI หรือตั้งค่า CLAUDE_CMD ใน environment' } });
  });

  proc.on('close', code => {
    activeSessions.delete(sessionId);
    // Flush remaining buffer lines
    if (streamBuffer.trim()) {
      const remainingLines = streamBuffer.split('\n');
      for (const line of remainingLines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') {
            buffer = event.result || buffer;
          }
          if (event.type === 'assistant' && event.message?.content) {
            const blocks = Array.isArray(event.message.content)
              ? event.message.content
              : [{ type: 'text', text: event.message.content }];
            for (const block of blocks) {
              if (block.type === 'text' && block.text) {
                buffer += block.text;
                safeSendWS({ type: 'stream', data: { text: block.text, sessionId } });
              } else if (block.type === 'thinking' && block.thinking) {
                safeSendWS({ type: 'stream_event', data: { event: 'thinking', text: block.thinking, raw: line, sessionId } });
              }
            }
          } else {
            safeSendWS({ type: 'stream_event', data: { event: event.type, raw: line, sessionId } });
          }
        } catch (e) {
          safeSendWS({ type: 'stream', data: { text: line + '\n', sessionId } });
        }
      }
    }
    saveMessage(sessionId, 'assistant', buffer);
    safeSendWS({ type: 'complete', data: { output: buffer, code, sessionId } });
  });

  activeSessions.set(sessionId, { process: proc, ws, isPTY: false });
}

function startPTY(ws, data, projectPath) {
  const sessionId = data.sessionId || 'default';
  
  if (activeSessions.has(sessionId)) {
    const old = activeSessions.get(sessionId);
    if (old.process) old.process.kill();
    if (old.logStream) { old.logStream.end(); old.logStream = null; }
    if (old.healthCheck) { clearInterval(old.healthCheck); old.healthCheck = null; }
  }

  const providerLabel = data.provider === 'kimi' ? 'Kimi' : 'Claude';
  ws.send(JSON.stringify({ type: 'status', data: { status: 'starting', message: `กำลังเปิด ${providerLabel} Interactive...` } }));

  const cliCmd = resolveCliCommand(data.provider, data.customCmd, true);
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
  const startTime = Date.now();
  let exited = false;
  
  // Start a shell and run claude inside it
  const proc = pty.spawn(shell, ['-c', cliCmd], {
    name: 'xterm-color',
    cols: data.cols || 80,
    rows: data.rows || 24,
    cwd: projectPath,
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' }
  });

  // Create log stream for PTY session persistence
  const logPath = path.join(PTY_LOG_DIR, `${sessionId}_${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  // PTY Stability: health check every 5s to detect unexpected exits
  const healthCheck = setInterval(() => {
    if (exited) { clearInterval(healthCheck); return; }
    try {
      process.kill(proc.pid, 0);
    } catch (e) {
      // Process is dead but onExit may not have fired
      clearInterval(healthCheck);
      if (!exited) {
        exited = true;
        if (logStream && !logStream.destroyed) logStream.end();
        activeSessions.delete(sessionId);
        ws.send(JSON.stringify({
          type: 'pty_exit',
          data: { code: -1, signal: 'HEALTH_CHECK', sessionId, error: true, message: 'PTY process disappeared unexpectedly', recommendChat: data.provider !== 'kimi' }
        }));
      }
    }
  }, 5000);

  proc.onData(chunk => {
    if (logStream && !logStream.destroyed) logStream.write(chunk);
    ws.send(JSON.stringify({ type: 'pty_output', data: { text: chunk, sessionId } }));
  });

  proc.onExit(({ exitCode, signal }) => {
    if (exited) return;
    exited = true;
    clearInterval(healthCheck);
    const duration = Date.now() - startTime;
    if (logStream && !logStream.destroyed) logStream.end();
    activeSessions.delete(sessionId);
    
    // Retry logic: if PTY died within 3 seconds, show error and recommend Chat mode
    if (duration < 3000 && exitCode !== 0) {
      ws.send(JSON.stringify({
        type: 'pty_exit',
        data: {
          code: exitCode,
          signal,
          sessionId,
          error: true,
          message: `${data.provider === 'kimi' ? 'Kimi' : 'Claude'} Interactive ปิดตัวเร็วเกินไป (${duration}ms)\nอาจมีปัญหากับ node-pty บนระบบของคุณ${data.provider !== 'kimi' ? '\n\nแนะนำ: ใช้ Chat Mode แทน (คลิกที่ Chat ด้านล่าง)' : ''}`,
          recommendChat: data.provider !== 'kimi'
        }
      }));
    } else {
      ws.send(JSON.stringify({ type: 'pty_exit', data: { code: exitCode, signal, sessionId } }));
    }
  });

  activeSessions.set(sessionId, { process: proc, ws, isPTY: true, logStream, logPath, startTime, healthCheck });
  ws.send(JSON.stringify({ type: 'pty_ready', data: { sessionId, logPath } }));
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
    if (session.logStream && !session.logStream.destroyed) {
      session.logStream.end();
      session.logStream = null;
    }
    if (session.healthCheck) {
      clearInterval(session.healthCheck);
      session.healthCheck = null;
    }
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

function handleSaveMessage(ws, data, projectPath) {
  if (!data.sessionId || !data.content) return;
  ensureSession(data.sessionId, projectPath);
  saveMessage(data.sessionId, data.role || 'system', data.content);
}

function handleKimiAPIChat(ws, data, projectPath) {
  const sessionId = data.sessionId || 'default';
  const apiKey = data.apiKey;
  const model = data.model || 'moonshot-v1-8k';
  const message = data.message;
  
  if (!apiKey) {
    return ws.send(JSON.stringify({ type: 'error', data: { message: 'Kimi API Key is required' } }));
  }
  
  // Save user message
  if (message && message.trim()) {
    ensureSession(sessionId, projectPath);
    saveMessage(sessionId, 'user', message.trim());
    // Update title from first user message if still default
    const existing = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId);
    if (existing && existing.title === 'New Chat') {
      updateSessionTitle(sessionId, message.trim().slice(0, 60));
    }
  }
  
  // Build messages from history
  const rows = getHistory(sessionId, 50);
  const messages = [];
  messages.push({ role: 'system', content: 'You are Kimi, a helpful assistant.' });
  for (const row of rows) {
    if (row.role === 'user' || row.role === 'assistant') {
      messages.push({ role: row.role, content: row.content });
    }
  }
  
  const requestData = JSON.stringify({
    model: model,
    messages: messages.slice(-20), // last 20 messages
    stream: true
  });
  
  const options = {
    hostname: 'api.moonshot.ai',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    }
  };
  
  console.log(`[KIMI API] Requesting model=${model} key_prefix=${apiKey.slice(0,8)}... sessionId=${sessionId}`);
  
  let buffer = '';
  
  const req = https.request(options, (res) => {
    console.log(`[KIMI API] Response status=${res.statusCode}`);
    if (res.statusCode !== 200) {
      let errorBody = '';
      res.on('data', chunk => { errorBody += chunk; });
      res.on('end', () => {
        console.log(`[KIMI API] Error body: ${errorBody}`);
        ws.send(JSON.stringify({ type: 'error', data: { message: `Kimi API error ${res.statusCode}: ${errorBody}`, sessionId } }));
      });
      return;
    }
    
    res.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            buffer += content;
            ws.send(JSON.stringify({ type: 'kimi_stream', data: { text: content, sessionId } }));
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    });
    
    res.on('end', () => {
      saveMessage(sessionId, 'assistant', buffer);
      ws.send(JSON.stringify({ type: 'kimi_complete', data: { output: buffer, code: 0, sessionId } }));
    });
    
    res.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error', data: { message: `Kimi API stream error: ${err.message}`, sessionId } }));
    });
  });
  
  req.on('error', (err) => {
    ws.send(JSON.stringify({ type: 'error', data: { message: `Kimi API request error: ${err.message}`, sessionId } }));
  });
  
  req.write(requestData);
  req.end();
}

const PORT = process.env.PORT || 3003;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ เซิร์ฟเวอร์พร้อมใช้งาน\n🌐 http://localhost:${PORT}\n📁 ${process.cwd()}\n🛑 กด Ctrl+C เพื่อหยุด`);
});
