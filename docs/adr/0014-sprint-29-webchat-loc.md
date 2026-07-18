# ADR-0014: Sprint 29 LOC — WebChat adapter

**Status:** Accepted  
**Date:** 2026-07-16  
**Context:** Sprint 29 (WebChat local channel)

## Context

Ядро на пороге **8064/8100** (ADR-0013). Sprint 29 добавляет локальный control-канал:

- `WebChatAdapter` — localhost HTTP (`127.0.0.1:8790`), pairing, inbound/outbound
- `gate/channels.ts` — `webchat` для 2FA cross-channel
- migration `0010` — ключи `channel_state` для WebChat

UI (`packages/aegis-webchat/`) — **вне** LOC ядра.

## Decision

Поднять мягкий порог `scripts/loc.mjs` с **8100 → 8600** LOC (+500 фактически ~463 в Sprint 29).

В scope ADR:

| Module | Purpose |
|--------|---------|
| `src/host/adapter/webchat/*` | HTTP adapter + pairing |
| `src/config/schema.ts` | `webchat` section |
| `src/host/main.ts` | wiring |
| `src/host/gate/channels.ts`, `second-factor.ts` | 2FA |
| `src/host/adapter/state.ts` | paired state |

Вне scope:

- `packages/aegis-webchat/`
- `packages/aegis-setup/` hints

## Consequences

- **Плюс:** onboarding без Telegram/Discord ботов.
- **Плюс:** единый trust writer очереди (adapter, не UI).
- **Минус:** +~285 LOC дисциплины.

## Alternatives rejected

- UI пишет в queue напрямую — второй trust writer.
- Shared port с dashboard — смешение read-only и write surface.
