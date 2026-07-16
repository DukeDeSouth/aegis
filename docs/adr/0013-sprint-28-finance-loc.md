# ADR-0013: Sprint 28 LOC — C9 finance dispatch

**Status:** Accepted  
**Date:** 2026-07-16  
**Context:** Sprint 28 (C9 finance read-only)

## Context

Ядро на пороге **7920/7920** (ADR-0011). Sprint 28 добавляет оркестрацию C9:

- `/finance-ingest` — MCP `gmail_finance_fetch` → sandbox `parse_finance.sh`
- `/finance-report` — sandbox `report_finance.sh`

CalDAV, Notion, Drive — **вне** ядра (пресеты `connectors/`).

## Decision

Поднять мягкий порог `scripts/loc.mjs` с **7920 → 8100** LOC (+180).

В scope ADR:

| Module | Purpose |
|--------|---------|
| `src/host/orchestrator/loop.ts` | finance command handlers |
| `src/host/web/fetcher.ts` | finance script runner |

Вне scope:

- `connectors/{finance,caldav,notion}/`
- `connectors/google/server` Drive tools
- `migrations/`

## Consequences

- **Плюс:** детерминированный бюджет без LLM в суммах.
- **Плюс:** паттерн C8 `/watch` — минимальный core dispatch.
- **Минус:** +80 LOC дисциплины.

## Alternatives rejected

- LLM extraction из писем — V1/V4 риск, галлюцинации.
- Только skill без core — cron не может цепочку gmail→parse в одном шаге.
