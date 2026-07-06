# Скелет репозитория и тулчейн

План задачи Sprint 0 «Скелет репозитория: структура каталогов, линтер, CI-заготовка, тест-раннер». Следует [ADR-0006](adr/0006-core-language-and-sandbox-runtime.md) (TypeScript / Node LTS) и принципу «свой код — только доверенное ядро».

## Структура каталогов

```
aegis/
├── docs/                    # как сейчас: концепт, модели, ADR, эта схема
├── src/
│   ├── host/                # доверенное ядро
│   │   ├── adapter/         #   Channel Adapter (Telegram)
│   │   ├── queue/           #   inbound/outbound очереди (queue.db)
│   │   ├── orchestrator/    #   петля P-LLM
│   │   ├── gate/            #   gate engine (классы действий, fail-closed)
│   │   ├── budget/          #   budget engine
│   │   └── audit/           #   audit log (hash chain)
│   ├── memory/              # store, FTS-поиск, promotion, курация
│   ├── llm/                 # тонкий клиент (ADR-0008), профили p_llm/q_llm
│   ├── sandbox/             # интерфейс SandboxRunner + Docker-реализация
│   └── config/              # загрузка/валидация конфига (zod)
├── skills/                  # встроенные декларативные навыки (SKILL.md + manifest.json)
├── migrations/              # 0001-init.sql, ... (нумерованные, только вперёд)
├── test/
│   ├── unit/
│   └── integration/         # включая тесты V1–V7 из MVP_SCOPE по мере готовности
├── deploy/
│   ├── docker-compose.yml   # host + broker + (пример) ollama
│   ├── systemd/aegis.service
│   └── broker/              # конфиг выбранного credential-proxy (Sprint 3)
├── scripts/                 # loc-подсчёт, dev-утилиты
├── package.json / package-lock.json
├── tsconfig.json            # strict: true, NodeNext
├── eslint.config.js         # flat config
├── .github/workflows/ci.yml
└── README.md / ROADMAP.md / ARCHITECTURE.md
```

Границы доменов видны структурой: всё под `src/` — Host-ядро и его контракты; broker — не наш код (только конфиг в `deploy/broker/`); код навыков живёт в `skills/` как данные, ядром не импортируется.

## Тулчейн

| Инструмент        | Выбор                                    | Замечание                                                |
| ----------------- | ---------------------------------------- | -------------------------------------------------------- |
| Рантайм           | Node.js LTS (pin в `.nvmrc` и `engines`) | ADR-0006                                                 |
| Пакетный менеджер | npm + lockfile                           | `npm ci --ignore-scripts` в CI                           |
| Язык              | TypeScript strict                        | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Линтер            | ESLint (flat) + Prettier                 | typescript-eslint recommended-type-checked               |
| Тесты             | Vitest                                   | unit + integration; integration с реальным SQLite-файлом |
| CI                | GitHub Actions                           | lint → typecheck → test → audit → loc-report             |

## Зависимости ядра (закрытый список)

Добавление зависимости в `src/` — ревью как у кода (supply-chain-политика ADR-0006):

- `better-sqlite3` — SQLite (WAL, FTS5, RETURNING);
- Telegram-библиотека — выбор в Sprint 2 (кандидат grammY);
- `zod` — валидация конфига и manifest.json.

Всё остальное — devDependencies. Provider-SDK для LLM не подключаются (ADR-0008).

## CI-заготовка

```yaml
# .github/workflows/ci.yml (набросок)
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm rebuild better-sqlite3 # единственный разрешённый build-script
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm audit --omit=dev --audit-level=high
      - run: npm run loc # предупреждение при src/ > 4000 LOC
```

## Контроль размера ядра

`npm run loc` — подсчёт непустых строк TypeScript в `src/` (скрипт в `scripts/`); порог 4000 — предупреждение в CI и вопрос к ревью, не хард-блок. Цель — удерживать ядро читаемым (MVP-критерий «ядро читается за разумное время»).

## Definition of Done (из SPRINTS, Sprint 0)

- [x] Каталоги созданы, `package.json`/`tsconfig`/`eslint.config` на месте
- [x] `hello world`-пайплайн CI зелёный (lint+typecheck+test на пустом ядре) — локально; CI-workflow подтвердится первым push
- [x] Миграции `0001-{queue,memory,audit}.sql` = DDL из [`MEMORY_SCHEMA.md`](MEMORY_SCHEMA.md) (три файла — по одному на БД-файл; применение и инварианты проверяет `test/integration/migrations.test.ts`)
- [x] `.nvmrc`, lockfile, политика `--ignore-scripts` действуют (проверено `npm ci --ignore-scripts` + `npm rebuild better-sqlite3`)
