# Ответ внешним тестерам (2026-07-18)

Краткий разбор находок против репозитория `DukeDeSouth/aegis`, коммит **`f303b6a`** (`origin/main` на момент аудита).

## Подтверждённые находки (исправлены в Sprint 41)

| ID | Находка | Статус |
|----|---------|--------|
| FIX-1 | `/remember` игнорировал queue provenance и писал `owner` в БД | **Исправлено** — `owner_only` + audit `knowledge.denied` |
| FIX-2 | Brute-force `POST /api/pair` без rate-limit | **Исправлено** — lockout 5 fails, backoff 60s→15m |
| FIX-3 | CSP отсутствовал на API-ответах WebChat | **Исправлено** — заголовки на всех путях |

## False positives (не подтверждены)

Тестеры ссылались на «отсутствующие» артефакты. В `f303b6a` они присутствуют:

### Миграции 0009–0014

```
migrations/0009-queue.sql
migrations/0010-queue.sql
migrations/0011-queue.sql
migrations/0012-queue.sql
migrations/0013-queue.sql
migrations/0014-memory.sql
```

(После Sprint 41 добавлена `migrations/0014-queue.sql` для pairing lockout.)

### Коннекторы finance / travel

```
connectors/finance/SKILL.md
connectors/finance/connector.json
connectors/finance/manifest.json
connectors/travel/SKILL.md
connectors/travel/connector.json
connectors/travel/manifest.json
```

### Skills media-pipeline

```
skills/media-pipeline/SKILL.md
skills/media-pipeline/manifest.json
```

(Полный список: `git ls-tree -r --name-only f303b6a`.)

## Вероятная причина расхождения

- Просмотр устаревшего коммита или форка без push в `main`
- Локальный shallow clone без полного дерева
- Путаница между `0014-memory.sql` (память) и queue-миграциями

## Рекомендация тестерам

Перед отчётом: `git fetch origin && git checkout main && git rev-parse HEAD` — сверить с актуальным `origin/main`.
