// ไฟล์: server.js
// รันด้วยคำสั่ง: node server.js
// เปิดเว็บ: http://localhost:3000

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const activeSessions = new Map();

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
      projectPath: process.cwd(),
      projectName: path.basename(process.cwd()),
      nodeVersion: process.version,
      platform: process.platform
    }
  }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      handleMessage(ws, data);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', data: { message: 'รูปแบบข้อมูลไม่ถูกต้อง' } }));
    }
  });

  ws.on('close', () => {
    for (const [id, session] of activeSessions) {
      if (session.process) session.process.kill();
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
  const projectPath = data.projectPath || process.cwd();

  switch (data.type) {
    case 'chat': handleChat(ws, data, projectPath); break;
    case 'terminal': handleTerminal(ws, data, projectPath); break;
    case 'read_file': handleReadFile(ws, data, projectPath); break;
    case 'write_file': handleWriteFile(ws, data, projectPath); break;
    case 'list_files': handleListFiles(ws, data, projectPath); break;
    case 'stop': handleStop(ws, data); break;
    default: ws.send(JSON.stringify({ type: 'error', data: { message: `ไม่รู้จักคำสั่ง: ${data.type}` } }));
  }
}

function handleChat(ws, data, projectPath) {
  const sessionId = data.sessionId || 'default';
  if (activeSessions.has(sessionId)) {
    activeSessions.get(sessionId).process?.kill();
  }

  ws.send(JSON.stringify({ type: 'status', data: { status: 'starting', message: 'กำลังเรียก Claude...' } }));

  const cliCmd = process.env.CLAUDE_CMD || 'claude';
  const proc = spawn(cliCmd, ['--print', data.message], {
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
    ws.send(JSON.stringify({ type: 'complete', data: { output: buffer, code, sessionId } }));
  });

  activeSessions.set(sessionId, { process: proc, ws });
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
    const content = fs.readFileSync(path.resolve(projectPath, data.path), 'utf8');
    ws.send(JSON.stringify({ type: 'file_content', data: { path: data.path, content } }));
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
    const files = entries.map(e => ({ name: e.name, isDirectory: e.isDirectory(), path: path.join(data.path || '', e.name) }));
    files.sort((a, b) => (a.isDirectory === b.isDirectory) ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1));
    ws.send(JSON.stringify({ type: 'file_list', data: { path: data.path || '.', files } }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'file_error', data: { error: e.message } }));
  }
}

function handleStop(ws, data) {
  const session = activeSessions.get(data.sessionId || 'default');
  if (session?.process) session.process.kill();
}

const PORT = process.env.PORT || 3003;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ เซิร์ฟเวอร์พร้อมใช้งาน\n🌐 http://localhost:${PORT}\n📁 ${process.cwd()}\n🛑 กด Ctrl+C เพื่อหยุด`);
});
