/**
 * Quick actions for WebChat UI — maps installed skills to sendable text.
 */
import type { SkillSummary } from '../../../skills/types.ts';

export interface WebchatQuickAction {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly kind: 'skill' | 'command';
  readonly description?: string;
}

/** Owner slash shortcuts (orchestrator handlers, not skills). */
export const OWNER_QUICK_COMMANDS: readonly WebchatQuickAction[] = [
  { id: 'cmd-skills', label: '/skills', text: '/skills', kind: 'command' },
  { id: 'cmd-status', label: '/status', text: '/status', kind: 'command' },
  { id: 'cmd-metrics', label: '/metrics', text: '/metrics', kind: 'command' },
  { id: 'cmd-search', label: '/search', text: '/search ', kind: 'command' },
];

/** Default message when user taps a skill chip. */
export function skillQuickText(name: string): string {
  switch (name) {
    case 'agent-status':
      return '/status';
    case 'echo-procedure':
      return 'echo test';
    case 'memory-search':
      return '/summarize последние темы';
    case 'reminders':
      return '/remind 09:00 напоминание';
    case 'web-digest':
      return '/digest';
    case 'web-fetch':
      return '/fetch https://example.com';
    default:
      return name;
  }
}

export function buildWebchatActions(skills: SkillSummary[]): WebchatQuickAction[] {
  const skillActions: WebchatQuickAction[] = skills.map((s) => ({
    id: `skill-${s.name}`,
    label: s.name,
    text: skillQuickText(s.name),
    kind: 'skill',
    description: s.description,
  }));
  return [...skillActions, ...OWNER_QUICK_COMMANDS];
}
