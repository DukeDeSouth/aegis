/**
 * Закрытый реестр действий ядра (ADR-0007: action_class; S8 добавит manifest).
 */
import type { ActionClass } from './types.ts';

export interface ActionSpec {
  readonly id: string;
  readonly actionClass: ActionClass;
  readonly requiresBroker: boolean;
  /** F2: ответ обязан пройти Q→P, не попадать в P-LLM как сырой контент. */
  readonly quarantineRequired?: boolean;
}

export const ACTIONS: Record<string, ActionSpec> = {
  'llm.invoke': { id: 'llm.invoke', actionClass: 'reversible', requiresBroker: false },
  'message.send': { id: 'message.send', actionClass: 'reversible', requiresBroker: false },
  'memory.read': { id: 'memory.read', actionClass: 'read-only', requiresBroker: false },
  'web.fetch': {
    id: 'web.fetch',
    actionClass: 'read-only',
    requiresBroker: true,
    quarantineRequired: true,
  },
  'file.read': { id: 'file.read', actionClass: 'read-only', requiresBroker: false },
  'file.write': { id: 'file.write', actionClass: 'reversible', requiresBroker: false },
  'sandbox.run': { id: 'sandbox.run', actionClass: 'reversible', requiresBroker: true },
  'action.dangerous': {
    id: 'action.dangerous',
    actionClass: 'irreversible',
    requiresBroker: false,
  },
};

/** Текст владельца, запускающий синтетическое irreversible-действие (только тесты/демо DoD). */
export const IRREVERSIBLE_TEST_CMD = '/test-irreversible';
