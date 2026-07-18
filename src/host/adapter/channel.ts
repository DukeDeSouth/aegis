/**
 * Контракт канала (F10): receive → queue, outbound → send. Без бизнес-логики.
 */
export interface ChannelAdapter {
  run(signal: AbortSignal): Promise<void>;
}

export const TG_SESSION_PREFIX = 'tg:';
export const DISCORD_SESSION_PREFIX = 'discord:';
export const EMAIL_SESSION_PREFIX = 'email:';
export const WEBCHAT_SESSION_PREFIX = 'webchat:';
export const WEBCHAT_DEFAULT_SESSION = 'webchat:local';
export const MATRIX_SESSION_PREFIX = 'matrix:';
export const SLACK_SESSION_PREFIX = 'slack:';

export function sessionSuffix(sessionId: string, prefix: string): string | undefined {
  if (!sessionId.startsWith(prefix)) return undefined;
  const rest = sessionId.slice(prefix.length);
  return rest.length > 0 ? rest : undefined;
}

export function handlesOutboundSession(sessionId: string, prefix: string): boolean {
  return sessionSuffix(sessionId, prefix) !== undefined;
}
