/**
 * C7-CalDAV (Sprint 28): тонкий stdio-MCP для CalDAV (Nextcloud и др.).
 * V2: Basic-auth только у broker :8084.
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const arg = process.argv[2] ?? '';
const BROKER = /^[a-zA-Z0-9.-]+:\d+$/.test(arg) ? arg : 'aegis-broker:8084';
const CALDAV_HOST = 'nextcloud.local';
const MAX_BODY = 512 * 1024;
const enc = encodeURIComponent;

function httpViaBroker(host, method, path, body, contentType) {
  const [brokerHost, brokerPort] = BROKER.split(':');
  const payload = body === undefined ? undefined : body;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: brokerHost,
        port: Number(brokerPort),
        method,
        path,
        headers: {
          host,
          accept: 'application/xml, text/plain, */*',
          ...(payload !== undefined
            ? { 'content-type': contentType ?? 'application/xml', 'content-length': Buffer.byteLength(payload) }
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

function countTag(xml, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'gi');
  return (xml.match(re) ?? []).length;
}

function summarizeXml(xml, tag) {
  const n = countTag(xml, tag);
  if (n === 0) return xml.length > 500 ? `${xml.slice(0, 500)}…` : xml || 'empty response';
  return `${n} ${tag}(s) found`;
}

const TOOLS = {
  calendar_list: {
    description: 'List calendars (read-only PROPFIND)',
    run: (a) => ({
      host: CALDAV_HOST,
      method: 'PROPFIND',
      path: need(a, 'path') || '/remote.php/dav/',
      body:
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>',
      depth: '1',
      summarize: (xml) => summarizeXml(xml, 'response'),
    }),
  },
  events_list: {
    description: 'List calendar events (read-only REPORT)',
    run: (a) => ({
      host: CALDAV_HOST,
      method: 'REPORT',
      path: need(a, 'calendar'),
      body:
        '<?xml version="1.0"?><c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">' +
        '<d:prop><d:getetag/><c:calendar-data/></d:prop></c:calendar-query>',
      summarize: (xml) => summarizeXml(xml, 'vevent'),
    }),
  },
  tasks_list: {
    description: 'List tasks (read-only REPORT)',
    run: (a) => ({
      host: CALDAV_HOST,
      method: 'REPORT',
      path: need(a, 'calendar'),
      body:
        '<?xml version="1.0"?><c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">' +
        '<d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VTODO"/></c:filter></c:calendar-query>',
      summarize: (xml) => summarizeXml(xml, 'vtodo'),
    }),
  },
  task_create: {
    description: 'Create a task (reversible)',
    run: (a) => {
      const uid = `aegis-${Date.now()}@local`;
      const title = need(a, 'title');
      const cal = need(a, 'calendar');
      const ics =
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${title}\r\n` +
        `STATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
      return {
        host: CALDAV_HOST,
        method: 'PUT',
        path: `${cal}${uid}.ics`,
        body: ics,
        contentType: 'text/calendar',
        summarize: () => `task created: ${uid}`,
      };
    },
  },
  task_complete: {
    description: 'Mark task completed (reversible PROPPATCH)',
    run: (a) => ({
      host: CALDAV_HOST,
      method: 'PROPPATCH',
      path: need(a, 'href'),
      body:
        '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop>' +
        '<c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">STATUS:COMPLETED</c:calendar-data>' +
        '</d:prop></d:set></d:propertyupdate>',
      summarize: () => 'task marked completed',
    }),
  },
  task_delete: {
    description: 'Delete a task (irreversible — requires /approve)',
    run: (a) => ({
      host: CALDAV_HOST,
      method: 'DELETE',
      path: need(a, 'href'),
      summarize: () => 'task deleted',
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
    res = await httpViaBroker(spec.host, spec.method, spec.path, spec.body, spec.contentType);
  } catch (err) {
    return errResult(`broker unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) return errResult('HTTP 401 — check caldav credentials at broker');
  if (res.status < 200 || res.status >= 300) return errResult(`HTTP ${res.status}`);
  return { content: [{ type: 'text', text: spec.summarize(res.body) }] };
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
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'aegis-caldav', version: '0.1.0' },
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
