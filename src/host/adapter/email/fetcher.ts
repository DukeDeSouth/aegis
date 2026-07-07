/**
 * Email-as-input (F10): inbound only, unconditional quarantine.
 */
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

/** Production stub until broker-IMAP skill ships. */
export class NullEmailFetcher implements EmailFetcher {
  async fetchSince(): Promise<EmailMessage[]> {
    return [];
  }
}
