# ADR-0019: WebChat locale injection

**Status:** Superseded (2026-07-16) — feature removed; язык задаётся в тексте сообщения пользователя.

## Decision

WebChat locale (`ru` | `en` | `uk`) хранится в `channel_state.webchat_locale`, default `ru`. Orchestrator добавляет `localeSystemDirective` в system prompt для всех `webchat:*` LLM вызовов.

## Consequences

- Перекрывает дрейф языка из dialog tail
- Другие каналы не затронуты
- Расширение списка языков — правка `locale.ts` + migration CHECK при новом key не нужен (value free string, validate in code)

## Related

- ADR-0014 WebChat
- ADR-0018 delivery
