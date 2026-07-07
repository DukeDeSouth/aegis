/**
 * P-A (Sprint 22): MCP Streamable HTTP клиент через credential broker.
 * Ядро шлёт POST на broker с `Host: <upstream>` (паттерн web-fetch F2);
 * Authorization инжектит Envoy. У клиента нет параметров аутентификации
 * по построению (V2). node:http, не fetch — Host входит в forbidden headers.
 */
import { request } from 'node:http';
import { extractTextContent, type McpToolCallResult } from './stdio-transport.ts';

const PROTOCOL_VERSION = '2025-03-26';
const SESSION_HEADER = 'mcp-session-id';
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface HttpMcpClientOptions {
  /** Адрес брокера, host:port (plain HTTP внутри internal-сети). */
  readonly brokerHost: string;
  /** Upstream Host — ключ allowlist-маршрута Envoy. */
  readonly host: string;
  /** Путь MCP-endpoint на upstream (по умолчанию /mcp). */
  readonly path?: string;
  readonly timeoutMs?: number;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

interface HttpReply {
  readonly status: number;
  readonly contentType: string;
  readonly sessionId: string | undefined;
  readonly text: string;
}

export class HttpMcpClient {
  private readonly url: string;
  private readonly host: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpMcpClientOptions) {
    this.url = `http://${opts.brokerHost}${opts.path ?? '/mcp'}`;
    this.host = opts.host;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const init = await this.post(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aegis', version: '0.0.1' },
      } },
      undefined,
      deadline,
    );
    const initBody = parseJsonRpc(init, 'initialize');
    if (initBody.error) throw new Error(initBody.error.message);

    await this.post(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      init.sessionId,
      deadline,
    );

    const call = await this.post(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
      init.sessionId,
      deadline,
    );
    const callBody = parseJsonRpc(call, 'tools/call');
    if (callBody.error) throw new Error(callBody.error.message);
    return extractTextContent(callBody.result);
  }

  private post(
    payload: Record<string, unknown>,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<HttpReply> {
    // Только транспортные заголовки: auth-заголовков нет по построению (V2).
    const headers: Record<string, string> = {
      Host: this.host,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(sessionId !== undefined ? { [SESSION_HEADER]: sessionId } : {}),
    };
    return new Promise((resolve, reject) => {
      const req = request(this.url, { method: 'POST', headers, signal }, (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            res.destroy(new Error('mcp http: response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          const sid = res.headers[SESSION_HEADER];
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'] ?? '',
            sessionId: typeof sid === 'string' ? sid : undefined,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      req.on('error', reject);
      req.end(JSON.stringify(payload));
    });
  }
}

function parseJsonRpc(reply: HttpReply, method: string): JsonRpcResponse {
  if (reply.status < 200 || reply.status >= 300) {
    throw new Error(`mcp http ${method}: upstream ${reply.status}`);
  }
  if (!reply.contentType.includes('application/json')) {
    throw new Error(`mcp http ${method}: unsupported response type (SSE not supported)`);
  }
  try {
    return JSON.parse(reply.text) as JsonRpcResponse;
  } catch {
    throw new Error(`mcp http ${method}: invalid JSON response`);
  }
}
