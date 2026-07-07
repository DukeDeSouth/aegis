# Навыки

Встроенные декларативные навыки Aegis. Навык — директория с двумя файлами:

- `SKILL.md` — процедура в формате Agent Skills spec (frontmatter + markdown);
- `manifest.json` — capability-манифест, источник истины для ядра.

Формат манифеста, реестр capability и правила валидации: [ADR-0007](../docs/adr/0007-skill-manifest-format.md).

Код ядра навыки не импортирует — они загружаются как данные (deny-by-default).

## Встроенные навыки

| Навык            | Тип           | Описание                                |
| ---------------- | ------------- | --------------------------------------- |
| `echo-procedure` | декларативный | Процедура echo для ответов пользователю |
| `web-digest`     | декларативный | Дайджест HTTPS-источников по `/digest` / cron |
| `reminders`      | декларативный | One-shot напоминания `/remind HH:MM` |
| `memory-search`  | декларативный | `/summarize` — FTS + один LLM-вызов |
| `agent-status`   | декларативный | `/status` — метрики, бюджет, pending |

Команды оркестратора: `/skills`, `/skill <name>`, `/skill-install <url>#<ref>` (owner), `/skill-dry-run <name>` (owner, code-навыки), `/skill-review|accept|reject <name>` (draft F5), `/curate-skills`, `/skill-archive|unarchive <name>` (F6), `/skill-approve <name>` (F7 — импорт с `requires_review`).

## Импорт внешних навыков (F7)

Репозиторий только с `SKILL.md` (без `manifest.json`) — валидный источник: при `/skill-install` ядро генерирует manifest по ADR-0007 (capabilities выводятся из тела). Навыки с `requires_review: true` не попадают в system prompt до `/skill-approve <name>`.
