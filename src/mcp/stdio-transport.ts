/**
 * F8: минимальный MCP stdio-клиент (JSON-RPC, newline-delimited).
 * Без внешнего SDK — только initialize + tools/call.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_LINE_BYTES = 512 * 1024;

export interface McpToolCallResult {
  readonly content: string;
  readonly isError: boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

export interface StdioMcpClientOptions {
  readonly command: readonly string[];
  readonly spawn?: SpawnFn;
  /** Env для MCP-процесса — только явно переданные ключи (V2). */
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function extractTextContent(result: unknown): McpToolCallResult {
  if (!result || typeof result !== 'object') {
    return { content: JSON.stringify(result), isError: false };
  }
  const r = result as { isError?: boolean; content?: unknown };
  const parts = Array.isArray(r.content) ? r.content : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      const t = (part as { text?: string }).text;
      if (typeof t === 'string') texts.push(t);
    }
  }
  const body = texts.length > 0 ? texts.join('\n') : JSON.stringify(result);
  return { content: body, isError: Boolean(r.isError) };
}

export class StdioMcpClient {
  private readonly command: readonly string[];
  private readonly spawnFn: SpawnFn;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: StdioMcpClientOptions) {
    if (opts.command.length === 0) throw new Error('mcp: empty command');
    this.command = opts.command;
    this.spawnFn = opts.spawn ?? spawn;
    this.env = opts.env ?? {};
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const [bin, ...argv] = this.command;
    const proc = this.spawnFn(bin!, [...argv], {
      env: { ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    let closed = false;

    const send = (method: string, params?: unknown): Promise<unknown> => {
      const id = nextId++;
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      proc.stdin.write(`${line}\n`);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    };

    const sendNotification = (method: string, params?: unknown): void => {
      const line = JSON.stringify({ jsonrpc: '2.0', method, params });
      proc.stdin.write(`${line}\n`);
    };

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (line.length > MAX_LINE_BYTES) return;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return;
      }
      if (msg.id === undefined) return;
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
    }, this.timeoutMs);

    try {
      await send('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aegis', version: '0.0.1' },
      });
      sendNotification('notifications/initialized', {});

      const result = await send('tools/call', { name: tool, arguments: args });
      return extractTextContent(result);
    } finally {
      clearTimeout(timer);
      closed = true;
      proc.stdin.end();
      proc.kill('SIGTERM');
      rl.close();
      for (const [, w] of pending) {
        if (!closed) w.reject(new Error('mcp: connection closed'));
      }
      pending.clear();
    }
  }
}
