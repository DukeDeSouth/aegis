/**
 * Тонкий LLM-клиент поверх OpenAI Chat Completions (ADR-0008).
 * Без provider-SDK; usage обязателен — при отсутствии от провайдера
 * подставляется верхняя оценка с estimated: true (fail-closed для бюджета).
 * Ключ читается из env по key_ref при создании и живёт только в замыкании.
 */
import type { LlmProfile } from '../config/schema.ts';
import type {
  LlmClient,
  LlmMessage,
  LlmResult,
  LlmToolCall,
  LlmUsage,
  OrchestratorRequest,
  QuarantineRequest,
} from './types.ts';

export class LlmError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'LlmError';
    this.transient = transient;
  }
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiCompatClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [500, 2000];

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class OpenAiCompatClient implements LlmClient {
  private readonly profile: LlmProfile;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(profile: LlmProfile, opts: OpenAiCompatClientOptions = {}) {
    this.profile = profile;
    const key = process.env[profile.key_ref];
    if (!key) {
      throw new Error(`LLM key not found: env ${profile.key_ref} is empty (fail-closed)`);
    }
    this.apiKey = key;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  async complete(request: OrchestratorRequest | QuarantineRequest): Promise<LlmResult> {
    const body = JSON.stringify({
      model: this.profile.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...('tools' in request && request.tools !== undefined && { tools: request.tools }),
    });

    let lastError: LlmError = new LlmError('LLM call not attempted', true);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.attempt(body, request);
      } catch (err) {
        lastError = err instanceof LlmError ? err : new LlmError(String(err), true);
        if (!lastError.transient || attempt === this.maxAttempts) throw lastError;
        await this.sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 2000);
      }
    }
    throw lastError;
  }

  private async attempt(
    body: string,
    request: OrchestratorRequest | QuarantineRequest,
  ): Promise<LlmResult> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.profile.base_url}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new LlmError(`network error: ${String(err)}`, true);
    }

    if (!response.ok) {
      throw new LlmError(
        `provider returned ${response.status}`,
        TRANSIENT_STATUSES.has(response.status),
      );
    }

    let json: ChatCompletionResponse;
    try {
      json = (await response.json()) as ChatCompletionResponse;
    } catch {
      throw new LlmError('provider returned non-JSON body', true);
    }

    const choice = json.choices?.[0]?.message;
    if (!choice) throw new LlmError('provider response has no choices', false);

    const message: LlmMessage = { role: 'assistant', content: choice.content ?? '' };
    const toolCalls: LlmToolCall[] | undefined = choice.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      message,
      ...(toolCalls !== undefined && { toolCalls }),
      usage: this.extractUsage(json, request),
    };
  }

  private extractUsage(
    json: ChatCompletionResponse,
    request: OrchestratorRequest | QuarantineRequest,
  ): LlmUsage {
    const u = json.usage;
    // Частичный или нулевой usage трактуем как отсутствующий: лучше переоценить (fail-closed).
    if (u && typeof u.prompt_tokens === 'number' && u.prompt_tokens > 0) {
      return {
        promptTokens: u.prompt_tokens,
        completionTokens: u.completion_tokens ?? request.maxTokens,
        estimated: false,
      };
    }
    const promptChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
    return {
      promptTokens: Math.ceil(promptChars / 3),
      completionTokens: request.maxTokens,
      estimated: true,
    };
  }
}
