#!/usr/bin/env node
/**
 * C20 travel-proxy: aviationstack access_key stays on broker host.
 * Envoy listener :8087 injects Authorization (raw API key); proxy maps to query param.
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.TRAVEL_PROXY_PORT ?? '8787');
const KEY_FILE = process.env.TRAVEL_API_KEY_FILE ?? '/etc/broker/travel/api-key.txt';
const UPSTREAM = 'api.aviationstack.com';

function loadKey() {
  try {
    return readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function upstreamGet(path, res) {
  const req = https.request(
    { hostname: UPSTREAM, port: 443, path, method: 'GET', headers: { Accept: 'application/json' } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, { 'content-type': 'application/json' });
      up.pipe(res);
    },
  );
  req.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream failed' } }));
  });
  req.end();
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const iata = url.searchParams.get('flight_iata');
    if (!iata) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'missing flight_iata' } }));
      return;
    }
    const hdr = req.headers.authorization ?? '';
    const key = hdr.replace(/^Bearer\s+/i, '').trim() || loadKey();
    if (!key) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'travel API key not configured' } }));
      return;
    }
    const path =
      `/v1/flights?access_key=${encodeURIComponent(key)}&flight_iata=${encodeURIComponent(iata)}`;
    upstreamGet(path, res);
  })
  .listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`travel-proxy listening on 127.0.0.1:${PORT}\n`);
  });
