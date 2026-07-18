/**
 * Outbound buffer for WebChat long-poll clients.
 */
export class WebchatOutbox {
  private readonly pending = new Map<string, string[]>();
  private readonly waiters = new Map<string, Array<(msgs: string[]) => void>>();

  push(sessionId: string, text: string): void {
    const batch = this.pending.get(sessionId);
    if (batch && batch.length > 0) {
      batch.push(text);
      return;
    }
    const list = this.waiters.get(sessionId);
    if (list && list.length > 0) {
      const resolve = list.shift()!;
      if (list.length === 0) this.waiters.delete(sessionId);
      else this.waiters.set(sessionId, list);
      resolve([text]);
      return;
    }
    this.pending.set(sessionId, [text]);
  }

  poll(sessionId: string, timeoutMs: number, signal: AbortSignal): Promise<string[]> {
    const queued = this.pending.get(sessionId);
    if (queued && queued.length > 0) {
      const batch = queued.splice(0);
      if (queued.length === 0) this.pending.delete(sessionId);
      return Promise.resolve(batch);
    }
    return new Promise((resolve) => {
      const onResolve = (msgs: string[]): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.removeWaiter(sessionId, onResolve);
        resolve(msgs);
      };
      const onAbort = (): void => {
        this.removeWaiter(sessionId, onResolve);
        clearTimeout(timer);
        resolve([]);
      };
      const list = this.waiters.get(sessionId) ?? [];
      list.push(onResolve);
      this.waiters.set(sessionId, list);
      const timer = setTimeout(() => onResolve([]), timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private removeWaiter(sessionId: string, target: (msgs: string[]) => void): void {
    const list = this.waiters.get(sessionId);
    if (!list) return;
    const next = list.filter((fn) => fn !== target);
    if (next.length === 0) this.waiters.delete(sessionId);
    else this.waiters.set(sessionId, next);
  }
}
