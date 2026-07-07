/**
 * F8: stdio MCP tools/call внутри sandbox (env-only, без секретов хоста).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PROTOCOL = '2024-11-05';
const cmd = JSON.parse(process.env.MCP_COMMAND_JSON ?? '[]');
const tool = process.env.MCP_TOOL ?? '';
const args = JSON.parse(process.env.MCP_ARGS_JSON ?? '{}');

if (!Array.isArray(cmd) || cmd.length === 0 || !tool) {
  console.error('mcp-bridge: missing MCP_COMMAND_JSON or MCP_TOOL');
  process.exit(2);
}

const proc = spawn(cmd[0], cmd.slice(1), {
  env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function notify(method, params) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

createInterface({ input: proc.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  const w = pending.get(msg.id);
  if (!w) return;
  pending.delete(msg.id);
  if (msg.error) w.reject(new Error(msg.error.message));
  else w.resolve(msg.result);
});

proc.on('exit', (code) => {
  if (code !== 0 && code !== null) process.exit(code);
});

try {
  await send('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'aegis-bridge', version: '0.0.1' },
  });
  notify('notifications/initialized', {});
  const result = await send('tools/call', { name: tool, arguments: args });
  const parts = Array.isArray(result?.content) ? result.content : [];
  const texts = parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text);
  const out = texts.length > 0 ? texts.join('\n') : JSON.stringify(result);
  if (result?.isError) {
    console.error(out);
    process.exit(1);
  }
  process.stdout.write(out);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  proc.kill('SIGTERM');
}
