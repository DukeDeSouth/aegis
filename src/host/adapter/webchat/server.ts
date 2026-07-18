/**
 * WebChat HTTP surface (Sprint 29): static UI + pairing + message + long-poll.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { AuditLog } from '../../audit/log.ts';
import type { QueueStore } from '../../queue/store.ts';
import type { ChannelState } from '../state.ts';
import { WEBCHAT_DEFAULT_SESSION } from '../channel.ts';
import {
  formatSetCookie,
  generateSessionToken,
  parseSessionCookie,
  sessionMatches,
} from './auth.ts';
import { classifyWebchatText } from './policy.ts';
import type { WebchatOutbox } from './outbox.ts';
import { buildWebchatActions } from './actions.ts';
import { clampHistoryLimit, episodesToHistoryMessages, type WebchatHistoryMessage } from './history.ts';
import type { SkillSummary } from '../../../skills/types.ts';

const ACTOR = 'webchat-adapter';
const POLL_TIMEOUT_MS = 25_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
};

export interface WebchatServerDeps {
  readonly host: string;
  readonly port: number;
  readonly pairingCode: string;
  readonly staticRoot: string;
  readonly queues: QueueStore;
  readonly audit: AuditLog;
  readonly state: ChannelState;
  readonly outbox: WebchatOutbox;
  readonly listSkills?: () => SkillSummary[];
  readonly getHistory?: (limit: number) => WebchatHistoryMessage[];
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function deny(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(status === 401 ? 'Unauthorized' : 'Forbidden');
}

export function createWebchatServer(deps: WebchatServerDeps): Server {
  const sessionId = WEBCHAT_DEFAULT_SESSION;

  return createHttpServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('error');
      }
    });
  });

  function pairingCodeMatches(code: string): boolean {
    return (
      Buffer.from(deps.pairingCode).length === Buffer.from(code).length &&
      timingSafeEqual(Buffer.from(deps.pairingCode), Buffer.from(code))
    );
  }

  function isAuthed(req: IncomingMessage): boolean {
    const cookie = parseSessionCookie(req.headers.cookie);
    const expected = deps.state.getWebchatSessionToken();
    return deps.state.isWebchatPaired() && sessionMatches(cookie, expected);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = req.url?.split('?')[0] ?? '/';

    if (method === 'GET' && path === '/api/status') {
      json(res, 200, { paired: deps.state.isWebchatPaired(), authed: isAuthed(req) });
      return;
    }

    if (method === 'POST' && path === '/api/pair') {
      const body = (await readJsonBody(req)) as { code?: string };
      const code = typeof body.code === 'string' ? body.code : '';
      if (!pairingCodeMatches(code)) {
        deps.audit.append({ actor: ACTOR, action: 'pairing.failed', decision: 'deny', payload: {} });
        deny(res, 403);
        return;
      }
      const token = generateSessionToken();
      const alreadyPaired = deps.state.isWebchatPaired();
      if (alreadyPaired) {
        deps.state.replaceWebchatSessionToken(token);
        deps.audit.append({
          actor: ACTOR,
          action: 'session.reauth',
          decision: 'info',
          payload: { channel: 'webchat' },
        });
      } else {
        deps.state.setWebchatPaired();
        deps.state.setWebchatSessionToken(token);
        deps.audit.append({
          actor: ACTOR,
          action: 'channel.paired',
          decision: 'info',
          payload: { channel: 'webchat' },
        });
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': formatSetCookie(token),
      });
      res.end(JSON.stringify({ ok: true, reauth: alreadyPaired }));
      return;
    }

    const authed = isAuthed(req);

    if (method === 'GET' && path === '/api/history') {
      if (!authed) {
        deny(res, 401);
        return;
      }
      const limitParam = new URL(req.url ?? '/', 'http://local').searchParams.get('limit');
      const limit = clampHistoryLimit(limitParam !== null ? Number(limitParam) : undefined);
      const messages = deps.getHistory?.(limit) ?? [];
      json(res, 200, { messages });
      return;
    }

    if (method === 'GET' && path === '/api/actions') {
      if (!authed) {
        deny(res, 401);
        return;
      }
      const skills = deps.listSkills?.() ?? [];
      json(res, 200, { actions: buildWebchatActions(skills) });
      return;
    }

    if (method === 'POST' && path === '/api/message') {
      if (!authed) {
        deps.audit.append({ actor: ACTOR, action: 'message.denied_unpaired', decision: 'deny', payload: {} });
        deny(res, 401);
        return;
      }
      const body = (await readJsonBody(req)) as { text?: string };
      const text = typeof body.text === 'string' ? body.text : '';
      const c = classifyWebchatText(text);
      switch (c.kind) {
        case 'owner_text':
          deps.queues.publish(
            'inbound',
            JSON.stringify({ text: c.text, session_id: sessionId }),
            'owner',
          );
          break;
        case 'approve_attempt':
          deps.queues.publish(
            'inbound',
            JSON.stringify({
              kind: 'approved_action',
              token: c.token,
              session_id: sessionId,
              ...(c.totpCode ? { totp_code: c.totpCode } : {}),
            }),
            'owner',
          );
          break;
        default:
          break;
      }
      json(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && path === '/api/poll') {
      if (!authed) {
        deny(res, 401);
        return;
      }
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      const messages = await deps.outbox.poll(sessionId, POLL_TIMEOUT_MS, ac.signal);
      json(res, 200, { messages });
      return;
    }

    if (method === 'GET') {
      const rel = path === '/' ? 'index.html' : path.replace(/^\//, '');
      const filePath = resolve(deps.staticRoot, rel);
      const rootResolved = resolve(deps.staticRoot);
      if (!filePath.startsWith(rootResolved) || !existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const ext = extname(filePath);
      const type = MIME[ext] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(readFileSync(filePath));
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  }
}

export function startWebchatServer(deps: WebchatServerDeps): Promise<Server> {
  const server = createWebchatServer(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.host, () => resolve(server));
  });
}
