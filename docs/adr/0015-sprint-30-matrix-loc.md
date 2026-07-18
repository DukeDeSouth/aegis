# ADR-0015: Sprint 30 LOC — Matrix adapter + C10/C11 decision

**Status:** Accepted  
**Date:** 2026-07-16  
**Context:** Sprint 30 (Matrix channel + go/no-go deferred connectors)

## Context

Ядро на пороге **8527/8600** (ADR-0014). Sprint 30 добавляет:

- `MatrixAdapter` — CS API `/sync` long-poll + `send m.room.message`
- `matrix` в `ChannelKind` для 2FA
- migration `0011` — `matrix_owner_user_id`, `matrix_sync_token`

Без matrix-js-sdk — fetch-only клиент (паттерн Discord).

## Decision

Поднять мягкий порог `scripts/loc.mjs` с **8600 → 9000** LOC (+400).

## Appendix: C10/C11 Go/No-Go

| ID | Decision | Rationale |
|----|----------|-----------|
| **C10 n8n** | **NO-GO** (defer Sprint 32+) | Arbitrary webhook semantics; нет demand-метрик волны 1–2; irreversible mapping burden на владельца |
| **C11 Playwright** | **NO-GO** (defer Sprint 32+) | C8 `/watch` + broker web-fetch покрывают read-only JS; headless browser = cookies/logins surface |

Код C10/C11 в Sprint 30 **не** реализуется — только запись в CONNECTORS.md.

## Consequences

- **Плюс:** privacy control-канал без неофициальных API.
- **Плюс:** Matrix-бриджи WhatsApp/Signal — на стороне владельца.
- **Минус:** v1 без E2EE verification; plain rooms only.

## Alternatives rejected

- matrix-js-sdk — dependency weight vs LOC budget.
- C10 go — risk/reward после волны 1–2 не оправдан.
