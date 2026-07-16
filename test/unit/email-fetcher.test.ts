import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { BrokerHttpEmailFetcher } from '../../src/host/adapter/email/fetcher.ts';

function startBridge(
  messages: { uid: number; from: string; subject: string; body: string }[],
): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const since = Number(url.searchParams.get('since_uid') ?? '0');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(messages.filter((m) => m.uid > since)));
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({ base: `http://127.0.0.1:${addr.port}`, close: () => srv.close() });
    });
  });
}

describe('BrokerHttpEmailFetcher', () => {
  it('fetchSince returns sorted messages above lastUid', async () => {
    const bridge = await startBridge([
      { uid: 2, from: 'a', subject: 's1', body: 'b1' },
      { uid: 5, from: 'b', subject: 's2', body: 'b2' },
    ]);
    const fetcher = new BrokerHttpEmailFetcher(bridge.base);
    const batch = await fetcher.fetchSince(2);
    expect(batch).toEqual([{ uid: 5, from: 'b', subject: 's2', body: 'b2' }]);
    bridge.close();
  });

  it('unreachable bridge throws', async () => {
    const fetcher = new BrokerHttpEmailFetcher('http://127.0.0.1:1');
    await expect(fetcher.fetchSince(0)).rejects.toThrow(/unreachable|ECONNREFUSED/i);
  });
});
