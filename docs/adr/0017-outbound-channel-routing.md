# ADR-0017: Outbound channel routing (release policy)

**Status:** Accepted  
**Date:** 2026-07-16  
**Context:** Hotfix post-Sprint 29 — WebChat outbound delivery failure

## Context

Все channel adapters (Telegram, Discord, Matrix, Slack, WebChat) потребляют **одну** очередь `outbound` через `QueueStore.claim()`.

Sprint 2 (MVP single-channel) трактовал «не мой `session_id`» как **malformed** → `markDead`. После Sprint 29/30/31 это убивает ответы для других каналов.

Инцидент 2026-07-16: при WebChat-only dev setup (dummy Telegram token, без `owner_user_id`) Telegram adapter перехватывал `webchat:local` outbound; ответы LLM не доходили до UI при успешном `llm.completed`.

## Decision

1. **`QueueStore.release(id)`** — вернуть сообщение в очередь (visible_at=now, claimed_by=NULL, attempts−1).
2. **Wrong channel:** valid payload, но prefix не совпадает → `release`, не `markDead`.
3. **Malformed payload:** невалидный JSON / schema → `markDead` (без изменений).
4. **Unpaired adapter:** не вызывать `claim('outbound')` (skip `runSender` loop), пока канал не paired.
5. **WebChat session:** различать `paired` (global) и `authed` (cookie); reauth через pairing-код → rotate `webchat_session_token`.

**v2 (deferred):** per-channel outbound queues + orchestrator routing.

## Consequences

- **Плюс:** multi-channel outbound без silent data loss.
- **Плюс:** WebChat-only dev/test стабилен без отключения Telegram в main.
- **Минус:** кратковременная гонка claim/release между adapters (приемлемо для single-tenant).
- **Минус:** `release` не решает multi-tab WebChat (outbox single consumer) — отдельный UX task.

## References

- M7: `m7-cycles/hotfix-webchat-outbound-delivery-и-sessия/`
- Sprint 29: ADR-0014 WebChat adapter
