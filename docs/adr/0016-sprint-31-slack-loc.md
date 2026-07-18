# ADR-0016: Sprint 31 LOC — Slack adapter

**Status:** Accepted  
**Date:** 2026-07-16  
**Context:** Sprint 31 (Slack channel C12)

## Context

Ядро на пороге **8908/9000** (ADR-0015). Sprint 31 добавляет:

- `SlackAdapter` — Socket Mode WS + `chat.postMessage`
- `slack` в `ChannelKind` для 2FA
- migration `0012` — `slack_owner_user_id`

Без `@slack/bolt` — native WebSocket + fetch (паттерн Discord).

## Decision

Поднять мягкий порог `scripts/loc.mjs` с **9000 → 9400** LOC (+400).

## Consequences

- **Плюс:** рабочий канал для Slack workspace без публичного HTTP endpoint.
- **Плюс:** Socket Mode идеален для self-hosted.
- **Минус:** cloud trust (Slack SaaS) — осознанный выбор владельца.

## Alternatives rejected

- `@slack/bolt` — dependency weight vs LOC budget.
- Events API HTTP — требует публичный URL.
