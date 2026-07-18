import { describe, expect, it } from 'vitest';
import { WebchatOutbox } from '../../src/host/adapter/webchat/outbox.ts';

const SESSION = 'webchat:local';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('WebchatOutbox', () => {
  it('delivers message to active waiter', async () => {
    const outbox = new WebchatOutbox();
    const ac = new AbortController();
    const poll = outbox.poll(SESSION, 500, ac.signal);
    outbox.push(SESSION, 'hello');
    await expect(poll).resolves.toEqual(['hello']);
  });

  it('returns pending immediately on next poll', async () => {
    const outbox = new WebchatOutbox();
    const ac = new AbortController();
    outbox.push(SESSION, 'queued');
    await expect(outbox.poll(SESSION, 500, ac.signal)).resolves.toEqual(['queued']);
  });

  it('does not lose message after poll timeout (stale waiter)', async () => {
    const outbox = new WebchatOutbox();
    const ac = new AbortController();
    const first = outbox.poll(SESSION, 30, ac.signal);
    await sleep(40);
    await expect(first).resolves.toEqual([]);

    outbox.push(SESSION, 'after-timeout');
    const second = outbox.poll(SESSION, 500, ac.signal);
    await expect(second).resolves.toEqual(['after-timeout']);
  });

  it('timeout then push then delayed poll — regression for lost delivery', async () => {
    const outbox = new WebchatOutbox();
    const ac = new AbortController();
    const timedOut = outbox.poll(SESSION, 25, ac.signal);
    await sleep(35);
    expect(await timedOut).toEqual([]);

    outbox.push(SESSION, 'HELLO');
    const next = outbox.poll(SESSION, 100, ac.signal);
    expect(await next).toEqual(['HELLO']);
  });

  it('abort removes waiter without consuming push', async () => {
    const outbox = new WebchatOutbox();
    const ac = new AbortController();
    const poll = outbox.poll(SESSION, 5000, ac.signal);
    ac.abort();
    await expect(poll).resolves.toEqual([]);

    outbox.push(SESSION, 'after-abort');
    const ac2 = new AbortController();
    await expect(outbox.poll(SESSION, 500, ac2.signal)).resolves.toEqual(['after-abort']);
  });
});
