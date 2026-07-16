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

/** RFC 2047 encoded-words in headers (Sprint 26). */
function decodeMimeWords(value) {
  return String(value).replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, _charset, encType, text) => {
      if (encType.toUpperCase() === 'B') {
        try {
          return Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8');
        } catch {
          return text;
        }
      }
      return text
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    },
  );
}

function httpViaBroker(host, method, path, bodyObj, httpOpts) {
  const [brokerHost, brokerPort] = BROKER.split(':');
  const isRaw = typeof bodyObj === 'string';
  const payload = bodyObj === undefined ? undefined : isRaw ? bodyObj : JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: brokerHost,
        port: Number(brokerPort),
        method,
        path,
        headers: {
          host,
          accept: httpOpts?.accept ?? (isRaw ? 'text/plain' : 'application/json'),
          ...(payload !== undefined
            ? {
                'content-type': httpOpts?.contentType ?? (isRaw ? 'text/plain' : 'application/json'),
                'content-length': Buffer.byteLength(payload),
              }
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

function fileLines(json) {
  const files = json.files ?? [];
  if (files.length === 0) return 'no files';
  return files.map((f) => `${f.id}: ${f.name ?? '(unnamed)'} (${f.mimeType ?? '?'})`).join('\n');
}

const FINANCE_QUERY =
  'newer_than:30d (subject:receipt OR subject:invoice OR subject:order OR subject:чек OR subject:счёт)';

async function gmailFinanceFetch(args) {
  const max = maxResults(args);
  const searchRes = await httpViaBroker(
    GMAIL_HOST,
    'GET',
    `/gmail/v1/users/me/messages?q=${enc(FINANCE_QUERY)}&maxResults=${max}`,
  );
  if (searchRes.status < 200 || searchRes.status >= 300) {
    throw new Error(`gmail search HTTP ${searchRes.status}`);
  }
  let searchJson;
  try {
    searchJson = JSON.parse(searchRes.body);
  } catch {
    throw new Error('invalid JSON from gmail search');
  }
  const ids = (searchJson.messages ?? []).map((m) => m.id).filter(Boolean);
  if (ids.length === 0) return '';
  let out = '';
  for (const id of ids) {
    const getRes = await httpViaBroker(
      GMAIL_HOST,
      'GET',
      `/gmail/v1/users/me/messages/${enc(id)}?format=metadata` +
        `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    );
    if (getRes.status < 200 || getRes.status >= 300) continue;
    let json;
    try {
      json = JSON.parse(getRes.body);
    } catch {
      continue;
    }
    const headers = json.payload?.headers ?? [];
    const h = (n) => decodeMimeWords(headers.find((x) => x.name === n)?.value ?? '?');
    const text = `From: ${h('From')}\nDate: ${h('Date')}\nSubject: ${h('Subject')}\n\n${json.snippet ?? ''}`;
    out += `---MSG ${id}---\n${text}\n\n`;
  }
  return out;
}

/** tool → {host, реквест, выжимка ответа} или Promise<string> для multi-step. */
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
        const h = (n) => decodeMimeWords(headers.find((x) => x.name === n)?.value ?? '?');
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
  gmail_finance_fetch: {
    description: 'Fetch receipt-like messages for finance ingest (read-only)',
    run: (a) => gmailFinanceFetch(a),
  },
  drive_list: {
    description: 'List Drive files (read-only)',
    run: (a) => ({
      host: CAL_HOST,
      method: 'GET',
      path:
        `/drive/v3/files?pageSize=${maxResults(a)}` +
        `&fields=files(id,name,mimeType,modifiedTime)`,
      summarize: fileLines,
    }),
  },
  drive_search: {
    description: 'Search Drive files (read-only)',
    run: (a) => ({
      host: CAL_HOST,
      method: 'GET',
      path:
        `/drive/v3/files?q=${enc(need(a, 'q'))}&pageSize=${maxResults(a)}` +
        `&fields=files(id,name,mimeType)`,
      summarize: fileLines,
    }),
  },
  drive_get_text: {
    description: 'Read small text file or export Google Doc as plain text (read-only)',
    run: (a) => ({
      host: CAL_HOST,
      method: 'GET',
      path: `/drive/v3/files/${enc(need(a, 'id'))}?alt=media`,
      summarize: (_json, raw) => {
        const text = typeof raw === 'string' ? raw : '';
        return text.length > 4000 ? `${text.slice(0, 4000)}…` : text || '(empty)';
      },
      rawBody: true,
    }),
  },
};

async function callTool(params) {
  const tool = TOOLS[params?.name];
  if (!tool) return errResult(`unknown tool: ${params?.name}`);
  let specOrText;
  try {
    specOrText = await tool.run(params.arguments ?? {});
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
  if (typeof specOrText === 'string') {
    return {
      content: [{ type: 'text', text: specOrText.length === 0 ? 'no messages' : specOrText }],
    };
  }
  const spec = specOrText;
  let res;
  try {
    res = await httpViaBroker(spec.host, spec.method, spec.path, spec.body, spec.httpOpts);
  } catch (err) {
    return errResult(`broker unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) {
    return errResult('HTTP 401 from broker — google token not ready (check oauth-sidecar)');
  }
  if (res.status < 200 || res.status >= 300) return errResult(`HTTP ${res.status}`);
  if (spec.rawBody) {
    const text = spec.summarize({}, res.body);
    return { content: [{ type: 'text', text }] };
  }
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
