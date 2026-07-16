# ADR-0011: Sprint 27 LOC — out-of-band 2FA human-gate

**Status:** Accepted  
**Date:** 2026-07-16  
**Context:** Sprint 27 (2FA-approve, THREAT_MODEL V6)

## Context

Ядро на пороге **7650/7650** LOC (ADR-0012). Sprint 27 добавляет out-of-band подтверждение irreversible:

- `origin_session_id` / `required_channel` в pending
- модули `gate/channels`, `gate/second-factor`, `gate/totp`
- проверка канала в `handleApproved`
- wiring `gate.second_factor` в schema/main

**Примечание:** ADR-0011 зарезервирован в ADR-0012 для Sprint 27. Ошибочная ссылка «ADR-0011 для IMAP» в ранних черновиках SPRINTS §26 отменена — IMAP = ADR-0012.

## Decision

Поднять мягкий порог `scripts/loc.mjs` с **7650 → 7920** LOC (+270).

В scope ADR:

| Module | Purpose |
|--------|---------|
| `src/host/gate/channels.ts` | session → channel kind |
| `src/host/gate/second-factor.ts` | resolve required approve channel |
| `src/host/gate/totp.ts` | optional TOTP verify |
| `src/host/gate/pending.ts` | peek, origin/required columns |
| `src/host/orchestrator/loop.ts` | create + handleApproved deltas |
| `src/config/schema.ts` | `gate.second_factor` |
| `src/host/main.ts` | config wiring |

Вне scope (не в LOC ядра):

- `migrations/0009-queue.sql`
- `packages/aegis-dashboard/` pending hint
- `test/security/v9-channel-2fa.test.ts`

## Consequences

- **Плюс:** закрывает V6 «захват канала» при 2FA + двух paired-каналах.
- **Плюс:** дефолт `enabled: false` — zero regression для существующих установок.
- **Минус:** +170 LOC дисциплины; контроль через `npm run loc`.
- **Не меняется:** gate engine verdict logic, V2 broker, quarantine path.

## Alternatives rejected

- Вынести 2FA в `packages/aegis-gate` — ломает fail-closed inline approve path.
- Только документация «подтверждайте в другом чате» без enforcement — не закрывает V6.
