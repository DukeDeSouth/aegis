/**
 * C13-Social (Sprint 32): тонкий stdio-MCP для Postiz Public API.
 * V2: API key только у broker :8086 (Authorization без Bearer).
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const arg = process.argv[2] ?? '';
const BROKER = /^[a-zA-Z0-9.-]+:\d+$/.test(arg) ? arg : 'aegis-broker:8086';
const POSTIZ_HOST = 'postiz.local';
const API_PREFIX = '/public/v1';
const MAX_BODY = 512 * 1024;

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
          host,
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

function integrationLines(json) {
  const rows = Array.isArray(json) ? json : (json.integrations ?? []);
  if (rows.length === 0) return 'no integrations';
  return rows.map((i) => `${i.id}: ${i.identifier ?? '?'} ${i.name ?? ''}`.trim()).join('\n');
}

function analyticsSummary(json) {
  if (typeof json.summary === 'string') return json.summary;
  const metrics = json.metrics ?? json;
  const parts = [];
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v === 'number' || typeof v === 'string') parts.push(`${k}=${v}`);
  }
  return parts.length > 0 ? parts.join(', ') : JSON.stringify(json).slice(0, 400);
}

function postBody(args, type) {
  const integrationId = need(args, 'integration_id');
  const content = need(args, 'content');
  const platform = args?.platform ?? 'x';
  const date =
    typeof args?.date === 'string' && args.date.length > 0
      ? args.date
      : new Date().toISOString();
  return {
    type,
    date,
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: integrationId },
        value: [{ content, image: [] }],
        settings: { __type: platform },
      },
    ],
  };
}

const TOOLS = {
  integrations_list: {
    description: 'List connected Postiz channels (read-only)',
    run: () => ({
      host: POSTIZ_HOST,
      method: 'GET',
      path: `${API_PREFIX}/integrations`,
      summarize: integrationLines,
    }),
  },
  analytics_summary: {
    description: 'Platform analytics for an integration (read-only)',
    run: (a) => ({
      host: POSTIZ_HOST,
      method: 'GET',
      path: `${API_PREFIX}/analytics/${need(a, 'integration_id')}`,
      summarize: analyticsSummary,
    }),
  },
  post_draft: {
    description: 'Save social post draft (reversible)',
    run: (a) => ({
      host: POSTIZ_HOST,
      method: 'POST',
      path: `${API_PREFIX}/posts`,
      body: postBody(a, 'draft'),
      summarize: (json) => `draft id=${json.id ?? json.group ?? 'created'}`,
    }),
  },
  post_schedule: {
    description: 'Schedule social post (reversible)',
    run: (a) => ({
      host: POSTIZ_HOST,
      method: 'POST',
      path: `${API_PREFIX}/posts`,
      body: postBody(a, 'schedule'),
      summarize: (json) => `scheduled id=${json.id ?? json.group ?? 'created'}`,
    }),
  },
  post_publish: {
    description: 'Publish social post now (irreversible — requires /approve)',
    run: (a) => ({
      host: POSTIZ_HOST,
      method: 'POST',
      path: `${API_PREFIX}/posts`,
      body: postBody(a, 'now'),
      summarize: (json) => `published id=${json.id ?? json.group ?? 'sent'}`,
    }),
  },
  post_delete: {
    description: 'Delete scheduled/published post (irreversible — requires /approve)',
    run: (a) => ({
      host: POSTIZ_HOST,
      method: 'DELETE',
      path: `${API_PREFIX}/posts/${need(a, 'post_id')}`,
      summarize: () => 'post deleted',
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
  if (res.status === 401) return errResult('HTTP 401 — check Postiz API key at broker');
  if (res.status < 200 || res.status >= 300) return errResult(`HTTP ${res.status}`);
  if (spec.method === 'DELETE') return { content: [{ type: 'text', text: spec.summarize({}) }] };
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
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'aegis-social', version: '0.1.0' },
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
