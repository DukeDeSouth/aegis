/**
 * Контракт канала (F10): receive → queue, outbound → send. Без бизнес-логики.
 */
export interface ChannelAdapter {
  run(signal: AbortSignal): Promise<void>;
}

export const TG_SESSION_PREFIX = 'tg:';
export const DISCORD_SESSION_PREFIX = 'discord:';
export const EMAIL_SESSION_PREFIX = 'email:';

export function sessionSuffix(sessionId: string, prefix: string): string | undefined {
  if (!sessionId.startsWith(prefix)) return undefined;
  const rest = sessionId.slice(prefix.length);
  return rest.length > 0 ? rest : undefined;
}
