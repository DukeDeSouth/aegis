/**
 * C1 (Sprint 24): тонкий stdio-MCP сервер Gmail/Calendar для sandbox.
 *
 * V2 по построению: в этом коде НЕТ ни токенов, ни Authorization-заголовков —
 * запросы идут plain HTTP на broker (:8081), который сам инжектит Bearer из
 * SDS (oauth-sidecar, ADR-0010). Egress ограничен allowlist'ом sandbox.
 *
 * Адрес брокера: argv[2] вида host:port (direct-тесты); в sandbox bridge
 * префиксует argv путями /mcp-server/… — такие значения отбрасываются
 * валидацией и работает дефолт aegis-broker:8081.
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const arg = process.argv[2] ?? '';
const BROKER = /^[a-zA-Z0-9.-]+:\d+$/.test(arg) ? arg : 'aegis-broker:8081';
const GMAIL_HOST = 'gmail.googleapis.com';
const CAL_HOST = 'www.googleapis.com';
const MAX_BODY = 512 * 1024;
const enc = encodeURIComponent;

function httpViaBroker(host, method, path, bodyObj) {
  const [brokerHost, brokerPort] = BROKER.split(':');
  const payload = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: brokerHost,
        port: Number(brokerPort),
        method,
        path,
        headers: {
          host, // логический upstream: broker матчит virtual_host и инжектит кред
          accept: 'application/json',
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (data.length > MAX_BODY) req.destroy(new Error('response too large'));
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.setTimeout(20_000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const need = (args, key) => {
  const v = args?.[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing argument: ${key}`);
  return v;
};
const maxResults = (args) =>
  Number.isInteger(args?.max) && args.max > 0 && args.max <= 50 ? args.max : 10;

const rfc822 = (args) =>
  Buffer.from(
    `To: ${need(args, 'to')}\r\nSubject: ${need(args, 'subject')}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n${String(args?.body ?? '')}`,
  ).toString('base64url');

function messageIds(json) {
  const ids = (json.messages ?? []).map((m) => m.id).filter(Boolean);
  if (ids.length === 0) return 'no messages';
  return `${ids.length} message(s): ${ids.join(', ')} (use gmail_get {"id": …})`;
}

function eventLines(json) {
  const items = json.items ?? [];
  if (items.length === 0) return 'no events';
  return items
    .map((e) => `${e.start?.dateTime ?? e.start?.date ?? '?'} — ${e.summary ?? '(no title)'}`)
    .join('\n');
}

/** tool → {host, реквест, выжимка ответа}. Классы действий объявляет конфиг ядра. */
const TOOLS = {
  gmail_list: {
    description: 'List recent Gmail message ids (read-only)',
    run: (a) => ({
      host: GMAIL_HOST,
      method: 'GET',
      path: `/gmail/v1/users/me/messages?maxResults=${maxResults(a)}`,
      summarize: messageIds,
    }),
  },
  gmail_search: {
    description: 'Search Gmail with a query string (read-only)',
    run: (a) => ({
      host: GMAIL_HOST,
      method: 'GET',
      path: `/gmail/v1/users/me/messages?q=${enc(need(a, 'q'))}&maxResults=${maxResults(a)}`,
      summarize: messageIds,
    }),
  },
  gmail_get: {
    description: 'Read one message: headers + snippet (read-only)',
    run: (a) => ({
      host: GMAIL_HOST,
      method: 'GET',
      path:
        `/gmail/v1/users/me/messages/${enc(need(a, 'id'))}?format=metadata` +
        `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      summarize: (json) => {
        const headers = json.payload?.headers ?? [];
        const h = (n) => headers.find((x) => x.name === n)?.value ?? '?';
        return `From: ${h('From')}\nDate: ${h('Date')}\nSubject: ${h('Subject')}\n\n${json.snippet ?? ''}`;
      },
    }),
  },
  gmail_draft: {
    description: 'Create a draft email (reversible)',
    run: (a) => ({
      host: GMAIL_HOST,
      method: 'POST',
      path: '/gmail/v1/users/me/drafts',
      body: { message: { raw: rfc822(a) } },
      summarize: (json) => `draft created: ${json.id ?? '?'}`,
    }),
  },
  gmail_send: {
    description: 'Send an email (irreversible — requires /approve)',
    run: (a) => ({
      host: GMAIL_HOST,
      method: 'POST',
      path: '/gmail/v1/users/me/messages/send',
      body: { raw: rfc822(a) },
      summarize: (json) => `sent: ${json.id ?? '?'}`,
    }),
  },
  calendar_list: {
    description: 'List upcoming calendar events (read-only)',
    run: (a) => ({
      host: CAL_HOST,
      method: 'GET',
      path:
        `/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime` +
        `&maxResults=${maxResults(a)}&timeMin=${enc(a?.time_min ?? new Date().toISOString())}` +
        (a?.time_max ? `&timeMax=${enc(a.time_max)}` : ''),
      summarize: eventLines,
    }),
  },
  calendar_create: {
    description: 'Create a calendar event (reversible)',
    run: (a) => ({
      host: CAL_HOST,
      method: 'POST',
      path: '/calendar/v3/calendars/primary/events',
      body: {
        summary: need(a, 'summary'),
        start: { dateTime: need(a, 'start') },
        end: { dateTime: need(a, 'end') },
      },
      summarize: (json) => `event created: ${json.id ?? '?'}`,
    }),
  },
};

async function callTool(params) {
  const tool = TOOLS[params?.name];
  if (!tool) return errResult(`unknown tool: ${params?.name}`);
  let spec;
  try {
    spec = tool.run(params.arguments ?? {});
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
  let res;
  try {
    res = await httpViaBroker(spec.host, spec.method, spec.path, spec.body);
  } catch (err) {
    return errResult(`broker unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) {
    return errResult('HTTP 401 from broker — google token not ready (check oauth-sidecar)');
  }
  if (res.status < 200 || res.status >= 300) return errResult(`HTTP ${res.status}`);
  let json = {};
  try {
    json = JSON.parse(res.body);
  } catch {
    return errResult('invalid JSON from upstream');
  }
  return { content: [{ type: 'text', text: spec.summarize(json) }] };
}

const errResult = (text) => ({ content: [{ type: 'text', text }], isError: true });
const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const replyError = (id, message) =>
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } })}\n`,
  );

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'aegis-google', version: '0.1.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description })),
    });
  } else if (msg.method === 'tools/call') {
    reply(msg.id, await callTool(msg.params));
  } else {
    replyError(msg.id, `unknown method: ${msg.method}`);
  }
});
