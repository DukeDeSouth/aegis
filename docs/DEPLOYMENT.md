# Развёртывание Aegis (self-hosted MVP)

Пошаговое руководство для технического владельца. MVP рассчитан на **single-tenant**: один бот, один владелец, одна машина или VPS.

## Требования

| Компонент | Версия / примечание                                       |
| --------- | --------------------------------------------------------- |
| Node.js   | ≥ 24 (см. `.nvmrc`)                                       |
| Docker    | Для sandbox и security-тестов V2/V3; для broker в compose |
| LLM       | OpenAI-совместимый API (локальный Ollama или облако)      |
| Telegram  | Бот через [@BotFather](https://t.me/BotFather)            |

## Быстрый старт (native host)

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
- `llm.p_llm` / `llm.q_llm` — URL и модель (Q-LLM для карантина)
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

### Сетевые инварианты (V3)

- `aegis-internal` (`internal: true`) — без egress; только broker и эфемерные sandbox-контейнеры.
- `aegis-egress` — наружу ходит **только** broker.
- Не добавляйте лишние сервисы в `aegis-internal`.

## systemd (опционально)

Юнит для native-запуска (без сборки в `dist/`):

```ini
# /etc/systemd/system/aegis.service — см. deploy/systemd/aegis.service
sudo systemctl enable --now aegis
```

Задайте env через `EnvironmentFile=/etc/aegis/env`.

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
