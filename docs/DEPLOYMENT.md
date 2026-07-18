# Развёртывание Aegis (self-hosted MVP)

Пошаговое руководство для технического владельца. MVP рассчитан на **single-tenant**: один бот, один владелец, одна машина или VPS.

## Требования

| Компонент | Версия / примечание                                       |
| --------- | --------------------------------------------------------- |
| Node.js   | ≥ 24 (см. `.nvmrc`)                                       |
| Docker    | Для sandbox и security-тестов V2/V3; для broker в compose |
| LLM       | OpenAI-совместимый API (локальный Ollama или облако)      |
| Telegram  | Бот через [@BotFather](https://t.me/BotFather)            |

## Быстрый старт (рекомендуется — F9)

```bash
git clone <your-repo-url> aegis && cd aegis
npm ci --ignore-scripts && npm rebuild better-sqlite3
npx aegis-setup init          # или: npm run setup init
# отредактируйте .env.aegis — LLM keys
cd deploy && docker compose --env-file .env up -d broker && cd ..
set -a && source .env.aegis && npm start
npx aegis-setup verify
```

Визард генерирует: `aegis.config.json`, `.env.aegis`, `deploy/.env`, `deploy/docker-compose.yml`, broker templates, случайный pairing-код. Секреты **не** попадают в JSON-конфиг (ADR-0008).

Команды: `aegis-setup init | verify | upgrade` — см. `packages/aegis-setup/`.

## Быстрый старт (native host, вручную)

### 1. Клонирование и зависимости

```bash
git clone <your-repo-url> aegis && cd aegis
npm ci --ignore-scripts && npm rebuild better-sqlite3
```

### 2. Конфигурация

```bash
cp aegis.config.example.json aegis.config.json
```

Отредактируйте `aegis.config.json`:

- `data_dir` — каталог для SQLite (`queue.db`, `memory.db`, `audit.db`)
- `skills_dir` — каталог навыков (`./skills`)
- `llm.p_llm` / `llm.q_llm` — URL и модель (Q-LLM для карантина; профили могут указывать на **разных провайдеров** — см. [Мульти-модель](#мульти-модель-p-llm--q-llm))
- `telegram.*_ref` — **имена** env-переменных, не сами секреты
- `budget` (опционально) — дневной лимит токенов
- `learning.self_improvement_llm_enabled` — **false** по умолчанию (MVP)
- `schedules` — cron-задачи; для детерминированного fallback используйте `/search …`

### 3. Переменные окружения

| Переменная               | Назначение                                           |
| ------------------------ | ---------------------------------------------------- |
| `AEGIS_CONFIG`           | Путь к конфигу (default: `./aegis.config.json`)      |
| `AEGIS_P_LLM_KEY`        | Ключ P-LLM (если провайдер требует)                  |
| `AEGIS_Q_LLM_KEY`        | Ключ Q-LLM                                           |
| `AEGIS_TG_BOT_TOKEN`     | Токен Telegram-бота                                  |
| `AEGIS_TG_PAIRING_CODE`  | Одноразовый код pairing (придумайте сами)            |
| `AEGIS_SANDBOX_IMAGE`    | Docker-образ sandbox (default: `alpine:3.20`)        |
| `AEGIS_INTERNAL_NETWORK` | Имя internal-сети Docker (default: `aegis-internal`) |

Секреты **никогда** не кладите в `aegis.config.json` — только `*_ref` на env (ADR-0008).

## Мульти-модель (P-LLM / Q-LLM)

Схема ADR-0008 поддерживает **разные провайдеры** для оркестратора и карантина с первого дня. Типичная схема:

| Плоскость | Роль | Пример |
| --------- | ---- | ------ |
| **P-LLM** | Диалог владельца, tools разрешены | Локальный Ollama (`http://localhost:11434/v1`) |
| **Q-LLM** | Анализ недоверенного контента, **без** tools | Облако OpenRouter / OpenAI-compatible API |

Готовый пример конфига: [`aegis.config.dual-vendor.example.json`](../aegis.config.dual-vendor.example.json).

```bash
cp aegis.config.dual-vendor.example.json aegis.config.json
# .env.aegis или shell:
export AEGIS_P_LLM_KEY=ollama          # Ollama часто принимает любое значение
export AEGIS_Q_LLM_KEY=sk-or-v1-...    # ключ OpenRouter
```

При `aegis-setup init` визард спрашивает URL и модель для Q-LLM отдельно — можно оставить один провайдер (оба на Ollama) или развести вендоров.

**Проверка:** `npm test -- test/integration/dual-llm-loop.test.ts` — e2e V1: `/fetch` бьёт в оба endpoint, инъекция не вызывает `sandbox.run`.

### 4. Запуск

```bash
AEGIS_P_LLM_KEY=... AEGIS_Q_LLM_KEY=... \
AEGIS_TG_BOT_TOKEN=... AEGIS_TG_PAIRING_CODE=my-secret-code \
npm start
```

### 5. Pairing владельца

1. Напишите боту в Telegram: `/pair my-secret-code` (код из env).
2. С этого момента бот отвечает только вам; чужие сообщения отклоняются (audit).
3. Повторный pairing невозможен — владелец фиксируется в `channel_state`.

### 6. Проверка

```bash
npm test
npm run test:security   # требует Docker
npm run loc             # ядро ≤ 4000 LOC
```

В чате: `/metrics` — отчёт `reuse_rate` и бюджета (owner-only).

## Credential broker (compose)

Для навыков с внешними API — broker подставляет секрет; ядро и sandbox не видят сырой ключ (тест V2).

```bash
cd deploy
export AEGIS_BROKER_SECRET_FILE=/secure/path/token.txt
printf '%s' "$YOUR_API_KEY" > "$AEGIS_BROKER_SECRET_FILE" && chmod 600 "$AEGIS_BROKER_SECRET_FILE"
docker compose up -d broker
```

Подробности: [`deploy/broker/README.md`](../deploy/broker/README.md).

### Remote broker (два хоста, Sprint 39 S1)

Для продвинутой self-hosted установки: секреты **только** на выделенном broker VPS; core ходит через mTLS forwarder.

```bash
aegis-setup init --broker-mode remote --broker-host broker.internal.example --yes
# На core:
cd deploy && docker compose --env-file .env --profile remote-broker up -d broker-client
# На broker VPS (rsync deploy/broker-remote/):
docker compose up -d
```

Firewall: TCP **8443** на broker-хосте — только с IP core-хоста.  
Проверка: `aegis-setup verify` (smoke через broker-client).  
Тест: `test/security/v2-remote-broker.test.ts`.  
ADR: [ADR-0027](adr/0027-sprint-39-s1-remote-broker.md).

### Сетевые инварианты (V3)

- `aegis-internal` (`internal: true`) — без egress; только broker и эфемерные sandbox-контейнеры.
- `aegis-egress` — наружу ходит **только** broker.
- Не добавляйте лишние сервисы в `aegis-internal`.

### gVisor sandbox (Linux, Sprint 40 S2)

Опционально усилить изоляцию V3: user-space kernel вместо shared-kernel runc.

```json
{
  "sandbox": {
    "runtime": "gvisor",
    "workspace_dir": "./workspace"
  }
}
```

1. Установите [gVisor runsc](https://gvisor.dev/docs/user_guide/install/) и зарегистрируйте runtime — см. [`deploy/gvisor/README.md`](../deploy/gvisor/README.md).
2. `docker run --rm --runtime runsc alpine:3.20 true` — smoke вручную.
3. `aegis-setup verify` — при `runtime=gvisor` проверяет runsc автоматически.

По умолчанию `runtime: docker` (hardened Docker без изменений). На macOS gVisor недоступен — dev остаётся на Docker Desktop VM.  
Тест: `test/security/v3-gvisor-runtime.test.ts` (skip без runsc).  
ADR: [ADR-0028](adr/0028-sprint-40-s2-gvisor-loc.md), upgrade-path: [ADR-0006](adr/0006-core-language-and-sandbox-runtime.md).

## systemd (опционально)

Юнит для native-запуска (без сборки в `dist/`):

```ini
# /etc/systemd/system/aegis.service — см. deploy/systemd/aegis.service
sudo systemctl enable --now aegis
```

Задайте env через `EnvironmentFile=/etc/aegis/env`.

Юнит `deploy/systemd/aegis.service` использует `Type=notify` и `WatchdogSec=60`: ядро шлёт `WATCHDOG=1` после каждого цикла петли; при зависании systemd перезапустит процесс.

## Backup и restore (Sprint 35)

Полный снимок данных установки одной командой (queue.db, memory.db, workspace, skills, config):

```bash
aegis-setup backup /path/to/backup-$(date +%Y%m%d).tar.gz
aegis-setup restore /path/to/backup-20260717.tar.gz
```

Архив содержит `manifest.json` с путями и версией схемы. SQLite-базы копируются через `VACUUM INTO` для консистентного снимка. После `restore` перезапустите ядро (`systemctl restart aegis` или `docker compose restart aegis`).

## Healthcheck (Sprint 35)

Ядро поднимает loopback HTTP на `127.0.0.1:8791` (настраивается в `aegis.config.json` → `health.port`):

```bash
curl -s http://127.0.0.1:8791/health | jq
```

Ответ: `status` (`ok` / `degraded`), `lastTickAt`, `uptimeSec`. Дашборд (`packages/aegis-dashboard`) опрашивает этот endpoint и показывает строку статуса хоста на главной странице (`healthUrl` в конфиге дашборда, по умолчанию `http://127.0.0.1:8791/health`).

## Troubleshooting

| Симптом                      | Проверка                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Бот молчит                   | Pairing выполнен? `AEGIS_TG_BOT_TOKEN` верный?                                                |
| LLM ошибка                   | `base_url` доступен? Ключ в env по `key_ref`?                                                 |
| Security-тесты skip          | Docker daemon запущен?                                                                        |
| Scheduler не шлёт LLM-digest | Ожидаемо: `learning.self_improvement_llm_enabled: false`; используйте `/search` в cron-тексте |
| Budget exhausted             | `/metrics`; уведомление владельцу; детерминированный fallback                                 |

## Критерии готовности MVP

См. [`MVP_SCOPE.md`](MVP_SCOPE.md) — все пункты отмечены с привязкой к тестам V1–V4, V7 и LOC.
