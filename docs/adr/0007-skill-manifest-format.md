# 0007. Формат capability-манифеста навыка

- **Статус:** Accepted
- **Дата:** 2026-07-05

## Контекст

SKILLS_MODEL.md зафиксировал принцип (навыки как данные, deny-by-default capability) и черновик полей, но оставил открытыми формат, версионирование и набор стандартных capability. К 2026 сложился де-факто стандарт упаковки навыков — Agent Skills spec (agentskills.io; принят Anthropic, Microsoft Agent Framework, Goose): директория со `SKILL.md` (YAML frontmatter `name`/`description` + markdown-процедура), прогрессивное раскрытие (~100 токенов метаданных → тело <5000 токенов → ресурсы по требованию). Но спецификация не покрывает security-модель Aegis: поле `allowed-tools` экспериментально и нетипизировано, нет классов действий, сетевой политики и флага кода.

## Решение

Навык Aegis = директория, совместимая с Agent Skills spec, плюс **отдельный строгий манифест**:

```
skill-name/
├── SKILL.md          # Agent Skills spec: frontmatter + процедура (прогрессивное раскрытие)
├── manifest.json     # capability-манифест Aegis — источник истины для ядра
└── scripts/          # только при code: true
```

Формат `manifest.json` (schema v1):

```json
{
  "schema_version": 1,
  "name": "digest-inbox",
  "version": "0.1.0",
  "needs": ["email.read"],
  "network": "none",
  "action_class": "read-only",
  "code": false,
  "entrypoints": []
}
```

| Поле             | Тип                                     | Семантика                                                                                                            |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `schema_version` | integer                                 | Версия схемы манифеста. Незнакомая версия → отказ установки (fail-closed)                                            |
| `name`           | string, `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64 | Совпадает с директорией и frontmatter                                                                                |
| `version`        | string (semver)                         | Версия навыка; установка из git — по pinned commit/tag (SKILLS_MODEL)                                                |
| `needs`          | string[]                                | Capability из закрытого реестра (ниже). Неизвестная → отказ                                                          |
| `network`        | `"none"` \| string[]                    | Хосты (глоб `*.example.com` допустим); транслируется в allowlist broker                                              |
| `action_class`   | enum                                    | `read-only` \| `reversible` \| `irreversible` — максимум навыка; gate engine берёт max(класс действия, класс навыка) |
| `code`           | boolean                                 | `false` → `scripts/` запрещён; `true` → исполнение только в sandbox + verifiable loop + скан                         |
| `entrypoints`    | string[]                                | Файлы, разрешённые к запуску (только при `code: true`)                                                               |

**Стандартный реестр capability v1 (закрытый, deny-by-default):**
`email.read`, `email.draft`, `web.fetch`, `files.read`, `files.write`, `messages.send`, `schedule.manage`, `memory.read`, `memory.propose`.
Формат — `domain.verb`. Добавление capability = изменение реестра (ревью), не схемы; `schema_version` растёт только при несовместимом изменении структуры манифеста.

**Валидация — два слоя (оба fail-closed):**

1. JSON Schema (структура, типы, enum);
2. семантические правила ядра, невыразимые в схеме: `code:false ⇒ entrypoints=[]`; `network:"none"` несовместим с capability, требующими внешних хостов; `name` манифеста = frontmatter = директория (расхождение → отказ установки; manifest.json — источник истины).

## Последствия

**Плюсы:** переносимость (SKILL.md читается любой Agent-Skills-совместимой средой); строгая, машинно-проверяемая security-часть отделена от прозы; реестр эволюционирует без ломки схемы; gate engine получает типизированный вход.

**Минусы:** два файла на навык (дублирование name/description) — митигируется валидацией согласованности; закрытый реестр может оказаться неполным — митигируется дешёвой процедурой расширения; собственный формат требует документации для авторов навыков (войдёт в документацию Sprint 8).

## Альтернативы

- **Только frontmatter SKILL.md (`allowed-tools`)** — отвергнуто: экспериментальное, нетипизированное поле; не выражает network/action_class/code.
- **Полностью свой формат без SKILL.md** — отвергнуто: теряется совместимость с экосистемой и паттерн прогрессивного раскрытия.
- **Открытый (произвольный) словарь capability** — отвергнут: ломает deny-by-default, ядро не может осмысленно гейтить неизвестные строки.
