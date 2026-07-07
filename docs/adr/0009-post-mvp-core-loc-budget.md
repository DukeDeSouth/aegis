# ADR-0009: Post-MVP LOC budget для ядра

**Status:** Accepted  
**Date:** 2026-07-06  
**Context:** Sprint 11 (F1 — история диалога + active recall)

## Context

MVP зафиксировал целевой порог ~4000 LOC для доверенного ядра (`src/`). Sprint 11 добавляет детерминированный сборщик контекста (`buildSessionContext`) в `src/memory/context.ts` без выноса в отдельный процесс — логика остаётся в trust-домене host.

После реализации F1: **4278 LOC** (+291). Превышение обусловлено одной связной подсистемой (tail + recall + trim + UNTRUSTED), а не раздуванием оркестратора.

## Decision

Поднять **мягкий порог** контроля `scripts/loc.mjs` с **4000 → 5000** LOC для post-MVP фазы P0 (Sprint 11 F1 + Sprint 12 F2).

**Обновление 2026-07-06 (Sprint 14 F4):** порог **5000 → 5500** — `WorkspaceStore` + file gate + sandbox workspace mount (~200 LOC).

**Обновление 2026-07-06 (Sprint 15 F5):** порог **5500 → 6000** — `SkillProposalRunner` + draft lifecycle (~475 LOC).

**Обновление 2026-07-06 (Sprint 16 F6):** порог **6000 → 6500** — `SkillCurator` + skill metrics (~360 LOC).

**Обновление 2026-07-06 (Sprint 18 F8):** порог **7000 → 7500** — MCP sandbox bridge + pending irreversible (~180 LOC).

Правило сохраняется: каждая следующая фича ядра либо укладывается в остаток, либо выносится из `src/` (sandbox, отдельный процесс), либо требует новый ADR.

## Consequences

- **Плюс:** F1 реализуем без искусственного дробления `context.ts`.
- **Минус:** ядро читается дольше; контроль через ADR и `npm run loc` остаётся обязательным.
- **Не меняется:** принцип «свой код — только доверенное ядро»; broker/sandbox вне порога.

## Alternatives considered

1. **Оставить 4000** — потребовало бы вынос context builder в пакет вне `src/` без выигрыша в безопасности.
2. **6000 сразу** — слишком размывает дисциплина MVP; 5000 даёт запас на F3–F4.
