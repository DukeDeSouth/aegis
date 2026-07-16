/**
 * Sprint 26 / F10: IMAP → HTTP bridge в trust-домене broker.
 * Креды только здесь; ядро читает GET /messages?since_uid=N (BrokerHttpEmailFetcher).
 *
 * Env:
 *   IMAP_CREDS_FILE — json {host, port?, user, password, mailbox?} (обязателен)
 *   IMAP_BRIDGE_PORT — listen port (default 8090)
 */
import { createServer } from 'node:http';
import { connect } from 'node:tls';
import { readFileSync } from 'node:fs';

const CREDS_FILE = process.env.IMAP_CREDS_FILE ?? '/etc/imap/creds.json';
const PORT = Number(process.env.IMAP_BRIDGE_PORT ?? '8090');

function readLines(socket) {
  let buf = '';
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('* BYE')) socket.destroy();
      }
    };
    const onEnd = () => resolve(buf);
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
  });
}

function imapCommand(socket, tag, cmd, collectUntilTag = true) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (!collectUntilTag) return;
      if (buf.includes(`\r\n${tag} OK`) || buf.includes(`\r\n${tag} NO`) || buf.includes(`\r\n${tag} BAD`)) {
        socket.off('data', onData);
        resolve(buf);
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.write(`${tag} ${cmd}\r\n`);
    if (!collectUntilTag) resolve('');
  });
}

function parseFetchBlocks(text) {
  const out = [];
  const re = /\* (\d+) FETCH \(([^)]*)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const uid = Number(m[1]);
    const inner = m[2] ?? '';
    const from = /BODY\[HEADER\.FIELDS \(FROM\)\] \{(\d+)\}\r\n([\s\S]*?)\r\n/.exec(inner)?.[2]?.trim() ?? '';
    const subject =
      /BODY\[HEADER\.FIELDS \(SUBJECT\)\] \{(\d+)\}\r\n([\s\S]*?)\r\n/.exec(inner)?.[2]?.trim() ?? '';
    const body = /BODY\[TEXT\] \{(\d+)\}\r\n([\s\S]*?)(?:\r\n\)|$)/.exec(inner)?.[2] ?? '';
    out.push({ uid, from: from.replace(/^From:\s*/i, ''), subject: subject.replace(/^Subject:\s*/i, ''), body });
  }
  return out;
}

async function fetchSince(creds, sinceUid) {
  const host = creds.host;
  const port = Number(creds.port ?? 993);
  const mailbox = creds.mailbox ?? 'INBOX';
  const socket = await new Promise((resolve, reject) => {
    const s = connect({ host, port, servername: host }, () => resolve(s));
    s.setTimeout(30_000, () => s.destroy(new Error('imap timeout')));
    s.on('error', reject);
  });
  try {
    await readLines(socket);
    await imapCommand(socket, 'a1', `LOGIN ${JSON.stringify(creds.user)} ${JSON.stringify(creds.password)}`);
    await imapCommand(socket, 'a2', `SELECT ${JSON.stringify(mailbox)}`);
    const search = await imapCommand(socket, 'a3', `UID SEARCH UID ${sinceUid + 1}:*`);
    const uids = [...search.matchAll(/UID SEARCH\s+([\d\s]+)/)]
      .flatMap((x) => (x[1] ?? '').trim().split(/\s+/))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > sinceUid);
    if (uids.length === 0) return [];
    const fetch = await imapCommand(
      socket,
      'a4',
      `UID FETCH ${uids.join(',')} (UID BODY[HEADER.FIELDS (FROM SUBJECT)] BODY[TEXT])`,
    );
    await imapCommand(socket, 'a5', 'LOGOUT', false);
    socket.end();
    return parseFetchBlocks(fetch).sort((a, b) => a.uid - b.uid);
  } finally {
    socket.destroy();
  }
}

function loadCreds() {
  const raw = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
  for (const k of ['host', 'user', 'password']) {
    if (typeof raw[k] !== 'string' || raw[k].length === 0) throw new Error(`creds: missing ${k}`);
  }
  return raw;
}

createServer(async (req, res) => {
  try {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url?.startsWith('/messages') && req.method === 'GET') {
      const since = Number(new URL(req.url, 'http://localhost').searchParams.get('since_uid') ?? '0');
      const sinceUid = Number.isInteger(since) && since >= 0 ? since : 0;
      const messages = await fetchSince(loadCreds(), sinceUid);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(messages));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`imap-bridge listening on :${PORT}`);
});
