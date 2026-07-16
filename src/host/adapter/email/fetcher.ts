export interface EmailMessage {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
}

export interface EmailFetcher {
  fetchSince(lastUid: number): Promise<EmailMessage[]>;
}

export class StaticEmailFetcher implements EmailFetcher {
  constructor(private readonly messages: EmailMessage[]) {}

  async fetchSince(lastUid: number): Promise<EmailMessage[]> {
    return this.messages.filter((m) => m.uid > lastUid);
  }
}

export class NullEmailFetcher implements EmailFetcher {
  async fetchSince(): Promise<EmailMessage[]> {
    return [];
  }
}

export class BrokerHttpEmailFetcher implements EmailFetcher {
  constructor(
    private readonly bridgeBase: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async fetchSince(lastUid: number): Promise<EmailMessage[]> {
    const base = this.bridgeBase.replace(/\/$/, '');
    let res: Response;
    try {
      res = await this.fetchFn(`${base}/messages?since_uid=${lastUid}`, {
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      throw new Error(`imap bridge unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`imap bridge HTTP ${res.status}`);
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: EmailMessage[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const uid = row.uid;
      if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= lastUid) continue;
      out.push({
        uid,
        from: typeof row.from === 'string' ? row.from : '?',
        subject: typeof row.subject === 'string' ? row.subject : '',
        body: typeof row.body === 'string' ? row.body : '',
      });
    }
    return out.sort((a, b) => a.uid - b.uid);
  }
}
