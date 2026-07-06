/**
 * Контракт тонкого LLM-клиента (ADR-0008).
 * Q-LLM-запрос структурно не имеет поля tools — гарантия ADR-0005 выражена типом,
 * а не проверкой в рантайме.
 */

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** true — провайдер не вернул usage, подставлена верхняя оценка (fail-closed для бюджета). */
  estimated: boolean;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Аргументы как строка JSON — парсинг и валидация на стороне оркестратора. */
  arguments: string;
}

interface LlmRequestBase {
  messages: LlmMessage[];
  maxTokens: number;
  temperature?: number;
}

/** Запрос P-LLM (оркестратор): tools разрешены. */
export interface OrchestratorRequest extends LlmRequestBase {
  tools?: unknown[];
}

/** Запрос Q-LLM (карантин): поля tools нет by construction. */
export type QuarantineRequest = LlmRequestBase;

export interface LlmResult {
  message: LlmMessage;
  toolCalls?: LlmToolCall[];
  /** Обязателен: budget engine учитывает каждый вызов (TOKEN_ECONOMY). */
  usage: LlmUsage;
}

export interface LlmClient {
  complete(request: OrchestratorRequest | QuarantineRequest): Promise<LlmResult>;
}
