/**
 * C18 (Sprint 34): linkding REST API via broker :8090.
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const BROKER = 'aegis-broker:8090';
const HOST = 'linkding.local';
const MAX_BODY = 256 * 1024;

function httpViaBroker(method, path, bodyObj) {
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
          host: HOST,
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

const TOOLS = {
  bookmark_save: {
    description: 'Save URL to linkding (reversible)',
    run: (a) => {
      const url = need(a, 'url');
      return {
        method: 'POST',
        path: '/api/bookmarks/',
        body: { url, title: a?.title ?? url, unread: true },
        summarize: () => `saved: ${url}`,
      };
    },
  },
  bookmark_list: {
    description: 'List bookmarks (read-only)',
    run: (a) => ({
      method: 'GET',
      path: a?.unread === true ? '/api/bookmarks/?unread=true' : '/api/bookmarks/',
      summarize: (json) => {
        const list = json.results ?? json;
        if (!Array.isArray(list) || list.length === 0) return '(no bookmarks)';
        return list
          .slice(0, 25)
          .map((b) => `${b.id}: ${b.title} — ${b.url}`)
          .join('\n');
      },
    }),
  },
  bookmark_delete: {
    description: 'Delete bookmark (irreversible)',
    run: (a) => ({
      method: 'DELETE',
      path: `/api/bookmarks/${need(a, 'id')}/`,
      summarize: () => `delete requested: ${a?.id ?? '?'}`,
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
    res = await httpViaBroker(spec.method, spec.path, spec.body);
  } catch (err) {
    return errResult(`broker unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) return errResult('HTTP 401 — check linkding token');
  if (res.status < 200 || res.status >= 300) return errResult(`HTTP ${res.status}`);
  let json = {};
  if (res.body.length > 0 && spec.method !== 'DELETE') {
    try {
      json = JSON.parse(res.body);
    } catch {
      json = {};
    }
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
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'aegis-bookmarks', version: '0.1.0' },
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
