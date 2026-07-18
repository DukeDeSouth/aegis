/**
 * C17 (Sprint 34): Jellyfin + Radarr + Sonarr via dedicated broker listeners.
 * V2: no API keys in code — broker injects x-emby-token / x-api-key per port.
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const MAX_BODY = 512 * 1024;
const enc = encodeURIComponent;

const BACKENDS = {
  jellyfin: { broker: 'aegis-broker:8087', host: 'jellyfin.local' },
  radarr: { broker: 'aegis-broker:8088', host: 'radarr.local' },
  sonarr: { broker: 'aegis-broker:8089', host: 'sonarr.local' },
};

function httpViaBroker(backendKey, method, path, bodyObj) {
  const backend = BACKENDS[backendKey];
  if (!backend) throw new Error(`unknown backend: ${backendKey}`);
  const [brokerHost, brokerPort] = backend.broker.split(':');
  const payload = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: brokerHost,
        port: Number(brokerPort),
        method,
        path,
        headers: {
          host: backend.host,
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
    req.setTimeout(25_000, () => req.destroy(new Error('request timeout')));
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

const needInt = (args, key) => {
  const v = args?.[key];
  if (!Number.isInteger(v)) throw new Error(`missing argument: ${key}`);
  return v;
};

function linesFromList(items, fmt) {
  if (!Array.isArray(items) || items.length === 0) return '(empty)';
  return items.map(fmt).join('\n');
}

const TOOLS = {
  jellyfin_library_search: {
    description: 'Search Jellyfin library (read-only)',
    run: (a) => ({
      backend: 'jellyfin',
      method: 'GET',
      path: `/Items?Recursive=true&IncludeItemTypes=Movie,Series&SearchTerm=${enc(need(a, 'term'))}&Limit=15`,
      summarize: (json) =>
        linesFromList(json.Items, (it) => `${it.Id}: ${it.Name} (${it.Type})`),
    }),
  },
  jellyfin_item_get: {
    description: 'Get Jellyfin item by id (read-only)',
    run: (a) => ({
      backend: 'jellyfin',
      method: 'GET',
      path: `/Items/${enc(need(a, 'id'))}`,
      summarize: (json) => `${json.Name ?? '?'} — ${json.Overview ?? '(no overview)'}`,
    }),
  },
  jellyfin_sessions_list: {
    description: 'List active Jellyfin sessions (read-only)',
    run: () => ({
      backend: 'jellyfin',
      method: 'GET',
      path: '/Sessions',
      summarize: (json) =>
        linesFromList(
          json,
          (s) => `${s.UserName ?? '?'}: ${s.NowPlayingItem?.Name ?? 'idle'}`,
        ),
    }),
  },
  jellyfin_item_delete: {
    description: 'Delete Jellyfin item (irreversible — requires /approve)',
    run: (a) => ({
      backend: 'jellyfin',
      method: 'DELETE',
      path: `/Items/${enc(need(a, 'id'))}`,
      summarize: () => `delete requested: ${a?.id ?? '?'}`,
    }),
  },
  radarr_movie_search: {
    description: 'Lookup movie in Radarr index (read-only)',
    run: (a) => ({
      backend: 'radarr',
      method: 'GET',
      path: `/api/v3/movie/lookup?term=${enc(need(a, 'term'))}`,
      summarize: (json) =>
        linesFromList(json, (m) => `${m.title} (${m.year}) tmdb:${m.tmdbId}`),
    }),
  },
  radarr_queue_list: {
    description: 'List Radarr download queue (read-only)',
    run: () => ({
      backend: 'radarr',
      method: 'GET',
      path: '/api/v3/queue?page=1&pageSize=20',
      summarize: (json) =>
        linesFromList(
          json.records ?? [],
          (q) => `${q.title}: ${q.status} ${q.sizeleft ?? 0}b left`,
        ),
    }),
  },
  radarr_wanted_missing: {
    description: 'List missing movies in Radarr (read-only)',
    run: () => ({
      backend: 'radarr',
      method: 'GET',
      path: '/api/v3/wanted/missing?page=1&pageSize=20',
      summarize: (json) =>
        linesFromList(json.records ?? [], (m) => `${m.title} (${m.year})`),
    }),
  },
  radarr_movie_add: {
    description: 'Add movie to Radarr (reversible)',
    run: async (a) => {
      const term = need(a, 'term');
      const lookup = await httpViaBroker(
        'radarr',
        'GET',
        `/api/v3/movie/lookup?term=${enc(term)}`,
      );
      if (lookup.status < 200 || lookup.status >= 300) {
        return { text: `lookup failed HTTP ${lookup.status}` };
      }
      const hits = JSON.parse(lookup.body);
      const hit = Array.isArray(hits) ? hits[0] : undefined;
      if (!hit) return { text: `no match for: ${term}` };
      const body = {
        ...hit,
        qualityProfileId: a?.qualityProfileId ?? hit.qualityProfileId ?? 1,
        rootFolderPath: a?.rootFolderPath ?? '/movies',
        monitored: true,
        addOptions: { searchForMovie: true },
      };
      const add = await httpViaBroker('radarr', 'POST', '/api/v3/movie', body);
      if (add.status < 200 || add.status >= 300) return { text: `add failed HTTP ${add.status}` };
      return { text: `added: ${hit.title}` };
    },
  },
  radarr_movie_delete: {
    description: 'Delete movie from Radarr (irreversible)',
    run: (a) => ({
      backend: 'radarr',
      method: 'DELETE',
      path: `/api/v3/movie/${needInt(a, 'id')}?deleteFiles=false`,
      summarize: () => `delete requested: movie ${a?.id ?? '?'}`,
    }),
  },
  sonarr_series_search: {
    description: 'Lookup TV series (read-only)',
    run: (a) => ({
      backend: 'sonarr',
      method: 'GET',
      path: `/api/v3/series/lookup?term=${enc(need(a, 'term'))}`,
      summarize: (json) =>
        linesFromList(json, (s) => `${s.title} (${s.year}) tvdb:${s.tvdbId}`),
    }),
  },
  sonarr_queue_list: {
    description: 'List Sonarr download queue (read-only)',
    run: () => ({
      backend: 'sonarr',
      method: 'GET',
      path: '/api/v3/queue?page=1&pageSize=20',
      summarize: (json) =>
        linesFromList(
          json.records ?? [],
          (q) => `${q.title}: ${q.status} ${q.sizeleft ?? 0}b left`,
        ),
    }),
  },
  sonarr_series_add: {
    description: 'Add series to Sonarr (reversible)',
    run: async (a) => {
      const term = need(a, 'term');
      const lookup = await httpViaBroker(
        'sonarr',
        'GET',
        `/api/v3/series/lookup?term=${enc(term)}`,
      );
      if (lookup.status < 200 || lookup.status >= 300) {
        return { text: `lookup failed HTTP ${lookup.status}` };
      }
      const hits = JSON.parse(lookup.body);
      const hit = Array.isArray(hits) ? hits[0] : undefined;
      if (!hit) return { text: `no match for: ${term}` };
      const body = {
        ...hit,
        qualityProfileId: a?.qualityProfileId ?? hit.qualityProfileId ?? 1,
        rootFolderPath: a?.rootFolderPath ?? '/tv',
        monitored: true,
        addOptions: { searchForMissingEpisodes: true },
      };
      const add = await httpViaBroker('sonarr', 'POST', '/api/v3/series', body);
      if (add.status < 200 || add.status >= 300) return { text: `add failed HTTP ${add.status}` };
      return { text: `added: ${hit.title}` };
    },
  },
  sonarr_series_delete: {
    description: 'Delete series from Sonarr (irreversible)',
    run: (a) => ({
      backend: 'sonarr',
      method: 'DELETE',
      path: `/api/v3/series/${needInt(a, 'id')}?deleteFiles=false`,
      summarize: () => `delete requested: series ${a?.id ?? '?'}`,
    }),
  },
};

async function callTool(params) {
  const tool = TOOLS[params?.name];
  if (!tool) return errResult(`unknown tool: ${params?.name}`);
  let spec;
  try {
    spec = await Promise.resolve(tool.run(params.arguments ?? {}));
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
  if (spec && typeof spec.text === 'string') {
    return { content: [{ type: 'text', text: spec.text }] };
  }
  let res;
  try {
    res = await httpViaBroker(spec.backend, spec.method, spec.path, spec.body);
  } catch (err) {
    return errResult(`broker unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) {
    return errResult('HTTP 401 — check broker token files for this service');
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
  try {
    const out = spec.summarize(json);
    return { content: [{ type: 'text', text: String(out) }] };
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
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
      serverInfo: { name: 'aegis-medialibrary', version: '0.1.0' },
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
