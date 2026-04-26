#!/usr/bin/env node
// Mock Claude CLI - outputs NDJSON events to stdout like real claude --print --output-format stream-json

const message = process.argv[2] || 'Hello';
const delay = ms => new Promise(r => setTimeout(r, ms));

function out(obj) {
  console.log(JSON.stringify(obj));
}

async function main() {
  // Simulate session_id on first chunk
  out({
    type: "system",
    subtype: "hook_started",
    hook_id: "mock-" + Math.random().toString(36).slice(2, 10),
    hook_name: "SessionStart:start",
    session_id: "mock-session-" + Date.now(),
    timestamp: new Date().toISOString()
  });

  await delay(300);

  out({
    type: "system",
    subtype: "hook_completed",
    hook_id: "mock-" + Math.random().toString(36).slice(2, 10),
    hook_name: "SessionStart:start",
    session_id: "mock-session-" + Date.now(),
    timestamp: new Date().toISOString()
  });

  await delay(200);

  // Assistant response with thinking + text
  out({
    type: "assistant",
    message: {
      id: "msg_mock_1",
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "The user said: '" + message + "'. I should respond helpfully and concisely. Let me think about what they might need..."
        },
        {
          type: "text",
          text: "สวัสดีครับ! คุณพิมพ์ว่า: **" + message + "**\n\n"
        }
      ],
      model: "claude-sonnet-4-20250514",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 45 }
    },
    timestamp: new Date().toISOString()
  });

  await delay(400);

  // More text
  out({
    type: "assistant",
    message: {
      id: "msg_mock_2",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "นี่คือข้อความตอบกลับจาก **Mock Claude** 🎭\n\n"
        },
        {
          type: "text",
          text: "ผมสามารถแสดงได้หลายอย่าง:\n- **Bold text**\n- *Italic*\n- `inline code`\n\n"
        }
      ],
      model: "claude-sonnet-4-20250514",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 78 }
    },
    timestamp: new Date().toISOString()
  });

  await delay(300);

  // Another thinking block (some models send multiple)
  out({
    type: "assistant",
    message: {
      id: "msg_mock_3",
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Let me add a code example to make this more useful."
        },
        {
          type: "text",
          text: "ตัวอย่างโค้ด:\n\n```javascript\nfunction hello(name) {\n  return `Hello, ${name}!`;\n}\n\nconsole.log(hello('World'));\n```\n\n"
        }
      ],
      model: "claude-sonnet-4-20250514",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 120 }
    },
    timestamp: new Date().toISOString()
  });

  await delay(200);

  // Final chunk with stop_reason
  out({
    type: "assistant",
    message: {
      id: "msg_mock_4",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "หวังว่าจะเป็นประโยชน์นะครับ! ถ้ามีคำถามอื่นเพิ่มเติม ยินดีช่วยเสมอ 😊"
        }
      ],
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 156 }
    },
    timestamp: new Date().toISOString()
  });

  await delay(150);

  // Result event
  out({
    type: "result",
    result: "success",
    total_cost_usd: 0.0042,
    usage: {
      input_tokens: 12,
      output_tokens: 156,
      total_tokens: 168
    },
    timestamp: new Date().toISOString()
  });
}

main().catch(console.error);
