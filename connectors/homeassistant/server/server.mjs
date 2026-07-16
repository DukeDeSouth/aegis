/**
 * C4 (Sprint 25): тонкий stdio-MCP для Home Assistant REST API.
 *
 * V2: нет токенов и Authorization в коде — broker :8082 инжектит Bearer.
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const arg = process.argv[2] ?? '';
const BROKER = /^[a-zA-Z0-9.-]+:\d+$/.test(arg) ? arg : 'aegis-broker:8082';
const HA_HOST = 'homeassistant.local';
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

const limit = (args) =>
  Number.isInteger(args?.limit) && args.limit > 0 && args.limit <= 100 ? args.limit : 25;

function stateLine(s) {
  const attrs = s.attributes ?? {};
  const unit = attrs.unit_of_measurement ? ` ${attrs.unit_of_measurement}` : '';
  return `${s.entity_id}: ${s.state}${unit}`;
}

function statesSummary(json) {
  const list = Array.isArray(json) ? json : [];
  if (list.length === 0) return 'no states';
  return list.map(stateLine).join('\n');
}

const TOOLS = {
  states_list: {
    description: 'List entity states (read-only)',
    run: (a) => ({
      host: HA_HOST,
      method: 'GET',
      path: '/api/states',
      summarize: (json) => {
        const list = Array.isArray(json) ? json.slice(0, limit(a)) : [];
        return statesSummary(list);
      },
    }),
  },
  state_get: {
    description: 'Get one entity state (read-only)',
    run: (a) => ({
      host: HA_HOST,
      method: 'GET',
      path: `/api/states/${enc(need(a, 'entity_id'))}`,
      summarize: (json) => stateLine(json),
    }),
  },
  light_toggle: {
    description: 'Toggle a light (reversible)',
    run: (a) => ({
      host: HA_HOST,
      method: 'POST',
      path: '/api/services/light/toggle',
      body: { entity_id: need(a, 'entity_id') },
      summarize: () => `toggled: ${a?.entity_id ?? '?'}`,
    }),
  },
  climate_set_temperature: {
    description: 'Set climate target temperature (reversible)',
    run: (a) => {
      const temp = a?.temperature;
      if (typeof temp !== 'number' || !Number.isFinite(temp)) {
        throw new Error('missing argument: temperature');
      }
      return {
        host: HA_HOST,
        method: 'POST',
        path: '/api/services/climate/set_temperature',
        body: { entity_id: need(a, 'entity_id'), temperature: temp },
        summarize: () => `temperature set: ${a.entity_id} → ${temp}`,
      };
    },
  },
  lock_unlock: {
    description: 'Unlock a lock (irreversible — requires /approve)',
    run: (a) => ({
      host: HA_HOST,
      method: 'POST',
      path: '/api/services/lock/unlock',
      body: { entity_id: need(a, 'entity_id') },
      summarize: () => `unlock requested: ${a?.entity_id ?? '?'}`,
    }),
  },
  alarm_disarm: {
    description: 'Disarm alarm panel (irreversible — requires /approve)',
    run: (a) => ({
      host: HA_HOST,
      method: 'POST',
      path: '/api/services/alarm_control_panel/alarm_disarm',
      body: {
        entity_id: need(a, 'entity_id'),
        ...(a?.code !== undefined ? { code: String(a.code) } : {}),
      },
      summarize: () => `alarm disarm requested: ${a?.entity_id ?? '?'}`,
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
    return errResult('HTTP 401 from broker — ha token missing (check deploy/broker/ha/token.txt)');
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
      serverInfo: { name: 'aegis-homeassistant', version: '0.1.0' },
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
