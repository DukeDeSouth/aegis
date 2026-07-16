/**
 * C5 (Sprint 25): тонкий stdio-MCP для GitHub REST API.
 *
 * V2: нет PAT и Authorization в коде — broker :8083 инжектит Bearer.
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const arg = process.argv[2] ?? '';
const BROKER = /^[a-zA-Z0-9.-]+:\d+$/.test(arg) ? arg : 'aegis-broker:8083';
const GITHUB_HOST = 'api.github.com';
const MAX_BODY = 512 * 1024;
const enc = encodeURIComponent;
const GH_ACCEPT = 'application/vnd.github+json';
const GH_VERSION = '2022-11-28';

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
          accept: GH_ACCEPT,
          'x-github-api-version': GH_VERSION,
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

const needNumber = (args, key) => {
  const n = args?.[key];
  if (!Number.isInteger(n) || n <= 0) throw new Error(`missing argument: ${key}`);
  return n;
};

const repoPath = (a) =>
  `/repos/${enc(need(a, 'owner'))}/${enc(need(a, 'repo'))}`;

function issuesSummary(json) {
  const list = Array.isArray(json) ? json : [];
  if (list.length === 0) return 'no issues';
  return list
    .map((i) => `#${i.number} [${i.state}] ${i.title ?? '(no title)'}`)
    .join('\n');
}

const TOOLS = {
  issues_list: {
    description: 'List repository issues (read-only)',
    run: (a) => {
      const state = typeof a?.state === 'string' ? a.state : 'open';
      return {
        host: GITHUB_HOST,
        method: 'GET',
        path: `${repoPath(a)}/issues?state=${enc(state)}&per_page=20`,
        summarize: issuesSummary,
      };
    },
  },
  issue_get: {
    description: 'Get one issue by number (read-only)',
    run: (a) => ({
      host: GITHUB_HOST,
      method: 'GET',
      path: `${repoPath(a)}/issues/${needNumber(a, 'number')}`,
      summarize: (json) =>
        `#${json.number} [${json.state}] ${json.title ?? '(no title)'}\n\n${json.body ?? ''}`,
    }),
  },
  issue_create: {
    description: 'Open a new issue (reversible)',
    run: (a) => ({
      host: GITHUB_HOST,
      method: 'POST',
      path: `${repoPath(a)}/issues`,
      body: { title: need(a, 'title'), ...(a?.body ? { body: String(a.body) } : {}) },
      summarize: (json) => `issue created: #${json.number ?? '?'}`,
    }),
  },
  issue_comment: {
    description: 'Comment on an issue (reversible)',
    run: (a) => ({
      host: GITHUB_HOST,
      method: 'POST',
      path: `${repoPath(a)}/issues/${needNumber(a, 'number')}/comments`,
      body: { body: need(a, 'body') },
      summarize: (json) => `comment added: id ${json.id ?? '?'}`,
    }),
  },
  pr_merge: {
    description: 'Merge a pull request (irreversible — requires /approve)',
    run: (a) => ({
      host: GITHUB_HOST,
      method: 'PUT',
      path: `${repoPath(a)}/pulls/${needNumber(a, 'number')}/merge`,
      body: {},
      summarize: (json) => `merged: ${json.sha ?? 'ok'}`,
    }),
  },
  issue_close: {
    description: 'Close an issue (irreversible — requires /approve)',
    run: (a) => ({
      host: GITHUB_HOST,
      method: 'PATCH',
      path: `${repoPath(a)}/issues/${needNumber(a, 'number')}`,
      body: { state: 'closed' },
      summarize: (json) => `closed: #${json.number ?? '?'}`,
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
    return errResult(
      'HTTP 401 from broker — github token missing (check deploy/broker/github/token.txt)',
    );
  }
  if (res.status < 200 || res.status >= 300) return errResult(`HTTP ${res.status}`);
  let json = {};
  if (res.body.length > 0) {
    try {
      json = JSON.parse(res.body);
    } catch {
      return errResult('invalid JSON from upstream');
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
      serverInfo: { name: 'aegis-github', version: '0.1.0' },
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
