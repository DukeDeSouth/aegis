/**
 * Тонкий клиент Telegram Bot API поверх нативного fetch (паттерн ADR-0008, без SDK).
 * Токен читается из env по bot_token_ref один раз и живёт в замыкании.
 * Клиент НЕ ретраит — только классифицирует ошибку (TelegramError);
 * политика повторов у циклов адаптера (receiver: backoff, sender: visibility timeout).
 * Тексты ошибок не содержат URL — токен структурно не может утечь (IMPACT R2).
 */

export interface TgMessage {
  message_id: number;
  from?: { id: number };
  chat?: { id: number };
  text?: string;
  caption?: string;
  forward_origin?: unknown;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TelegramErrorOptions {
  transient: boolean;
  conflict?: boolean;
  retryAfterMs?: number;
}

export class TelegramError extends Error {
  readonly transient: boolean;
  readonly conflict: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, opts: TelegramErrorOptions) {
    super(message);
    this.name = 'TelegramError';
    this.transient = opts.transient;
    this.conflict = opts.conflict ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface TelegramClientOptions {
  fetchFn?: typeof fetch;
  /** Long polling timeout getUpdates, секунды. 0 в тестах — мгновенный ответ. */
  pollTimeoutS?: number;
  baseUrl?: string;
}

interface ApiEnvelope {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly pollTimeoutS: number;
  private readonly baseUrl: string;

  constructor(botTokenRef: string, opts: TelegramClientOptions = {}) {
    const token = process.env[botTokenRef];
    if (!token) {
      throw new Error(`telegram bot token env var is not set (ref: ${botTokenRef})`);
    }
    this.token = token;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.pollTimeoutS = opts.pollTimeoutS ?? 30;
    this.baseUrl = opts.baseUrl ?? 'https://api.telegram.org';
  }

  /** Long polling; signal прерывает висящий запрос (graceful shutdown, см. SIMULATION). */
  async getUpdates(offset: number | undefined, signal?: AbortSignal): Promise<TgUpdate[]> {
    const result = await this.call(
      'getUpdates',
      {
        ...(offset !== undefined && { offset }),
        timeout: this.pollTimeoutS,
        allowed_updates: ['message'],
      },
      signal,
    );
    return Array.isArray(result) ? (result as TgUpdate[]) : [];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text });
  }

  private async call(method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    // fetch-таймаут страхует зависший сокет; long poll должен успеть завершиться сам.
    const timeout = AbortSignal.timeout((this.pollTimeoutS + 10) * 1000);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (signal?.aborted) throw new TelegramError(`${method}: aborted`, { transient: true });
      // Текст исходной ошибки не включаем: cause может содержать URL с токеном.
      throw new TelegramError(`${method}: network error`, { transient: true });
    }

    let json: ApiEnvelope | undefined;
    try {
      json = (await res.json()) as ApiEnvelope;
    } catch {
      json = undefined;
    }

    if (!res.ok || !json?.ok) {
      const status = res.status;
      const retryAfterS = json?.parameters?.retry_after;
      throw new TelegramError(`${method}: HTTP ${status} (${json?.error_code ?? 'no body'})`, {
        transient: status === 429 || status >= 500,
        conflict: status === 409,
        ...(retryAfterS !== undefined && { retryAfterMs: retryAfterS * 1000 }),
      });
    }
    return json.result;
  }
}
