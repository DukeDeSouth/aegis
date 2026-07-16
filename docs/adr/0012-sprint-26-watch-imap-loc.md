# ADR-0012: Sprint 26 LOC — `/watch` + IMAP HTTP fetcher

**Status:** Accepted  
**Date:** 2026-07-16  
**Context:** Sprint 26 (C8 price tracker, IMAP email tail F10, connector upgrade)

## Context

Ядро на пороге **7500/7500** LOC (ADR-0009). Sprint 26 добавляет:

- `handleWatch` в orchestrator (~50 LOC) — dispatch cron `/watch` для C8 DoD
- `BrokerHttpEmailFetcher` + wiring в `main.ts` (~70 LOC) — IMAP через HTTP bridge
- `email.imap_bridge_host` в schema (~5 LOC)

Diff-логика C8 и IMAP TLS живут **вне** `src/` (`watch.sh`, `imap-bridge`).

## Decision

Поднять мягкий порог `scripts/loc.mjs` с **7500 → 7650** LOC.

В scope ADR:

- `src/host/orchestrator/loop.ts` — `/watch`
- `src/host/web/fetcher.ts` — `watch()`
- `src/host/adapter/email/fetcher.ts` — `BrokerHttpEmailFetcher`
- `src/host/main.ts` — email fetcher factory
- `src/config/schema.ts` — `email.imap_bridge_host`

Вне scope (не в LOC ядра): `skills/web-fetch/watch.sh`, `deploy/broker/imap-bridge/`, `connectors/watch/`, `packages/aegis-setup/`.

**Примечание:** ADR-0011 зарезервирован Sprint 27 (2FA gate) — не переиспользовать.

## Consequences

- **Плюс:** C8 и IMAP закрывают DoD без выноса trust-path в пакет.
- **Минус:** +150 LOC дисциплины; контроль через `npm run loc`.
- **Не меняется:** quarantine email, V2 broker pattern.
