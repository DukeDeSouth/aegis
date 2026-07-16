/**
 * C7-Notion (Sprint 28): тонкий stdio-MCP для Notion API.
 * V2: Bearer token только у broker :8085.
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const arg = process.argv[2] ?? '';
const BROKER = /^[a-zA-Z0-9.-]+:\d+$/.test(arg) ? arg : 'aegis-broker:8085';
const NOTION_HOST = 'api.notion.com';
const MAX_BODY = 512 * 1024;
const NOTION_VERSION = '2022-06-28';

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
          'notion-version': NOTION_VERSION,
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

function pageLines(json) {
  const results = json.results ?? [];
  if (results.length === 0) return 'no pages';
  return results
    .map((p) => {
      const title =
        p.properties?.title?.title?.[0]?.plain_text ??
        p.properties?.Name?.title?.[0]?.plain_text ??
        p.id;
      return `${p.id}: ${title}`;
    })
    .join('\n');
}

const TOOLS = {
  pages_search: {
    description: 'Search Notion pages (read-only)',
    run: (a) => ({
      host: NOTION_HOST,
      method: 'POST',
      path: '/v1/search',
      body: { query: a?.query ?? '', page_size: 10 },
      summarize: pageLines,
    }),
  },
  page_get: {
    description: 'Get page metadata (read-only)',
    run: (a) => ({
      host: NOTION_HOST,
      method: 'GET',
      path: `/v1/pages/${need(a, 'id')}`,
      summarize: (json) => `page ${json.id ?? '?'} archived=${json.archived ?? false}`,
    }),
  },
  blocks_list: {
    description: 'List page blocks (read-only)',
    run: (a) => ({
      host: NOTION_HOST,
      method: 'GET',
      path: `/v1/blocks/${need(a, 'id')}/children?page_size=20`,
      summarize: (json) => {
        const blocks = json.results ?? [];
        if (blocks.length === 0) return 'no blocks';
        return blocks.map((b) => `${b.type}: ${b.id}`).join('\n');
      },
    }),
  },
  page_append: {
    description: 'Append paragraph to page (reversible)',
    run: (a) => ({
      host: NOTION_HOST,
      method: 'PATCH',
      path: `/v1/blocks/${need(a, 'id')}/children`,
      body: {
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: need(a, 'text') } }],
            },
          },
        ],
      },
      summarize: () => 'block appended',
    }),
  },
  page_archive: {
    description: 'Archive a page (irreversible — requires /approve)',
    run: (a) => ({
      host: NOTION_HOST,
      method: 'PATCH',
      path: `/v1/pages/${need(a, 'id')}`,
      body: { archived: true },
      summarize: () => 'page archived',
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
  if (res.status === 401) return errResult('HTTP 401 — check notion token at broker');
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
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'aegis-notion', version: '0.1.0' },
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
