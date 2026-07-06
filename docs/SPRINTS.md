# Спринт-план

Разбивка фаз из [`../ROADMAP.md`](../ROADMAP.md) на спринты по 2 недели. Ориентир для малой команды (1–3 человека), не обязательство по датам. Каждый спринт имеет одну цель, задачи и Definition of Done. Спринты идут последовательно — принцип «сначала границы, потом удобства» сохранён.

Оценки в скобках — грубые (S ≈ 1–2 дня, M ≈ 3–4 дня, L ≈ неделя+).

---

## Sprint 0 — Фундамент решений (Фаза 0)

**Цель:** закрыть проектные развилки, блокирующие код.

- [x] ADR-0006: язык ядра и рантайм sandbox (M) — [ADR-0006](adr/0006-core-language-and-sandbox-runtime.md)
- [x] ADR-0007: формат capability-манифеста навыка (S) — [ADR-0007](adr/0007-skill-manifest-format.md)
- [x] Схема данных памяти: таблицы эпизодической + семантической (статусы, provenance, evidence) (M) — [MEMORY_SCHEMA.md](MEMORY_SCHEMA.md)
- [x] Скелет репозитория: структура каталогов, линтер, CI-заготовка, тест-раннер (S) — [REPO_LAYOUT.md](REPO_LAYOUT.md)
- [x] Выбор LLM-провайдера и абстракция вызова (OpenAI-совместимый) (S) — [ADR-0008](adr/0008-llm-provider-abstraction.md)

**DoD:** нет открытых вопросов, блокирующих Sprint 1; схема памяти зафиксирована в миграции (`migrations/0001-*.sql` + интеграционный тест инвариантов); lint+typecheck+test зелёные локально, CI-заготовка в `.github/workflows/ci.yml`. **Sprint 0 закрыт.**

---

## Sprint 1 — Ядро и очереди (Фаза 1, часть 1)

**Цель:** сообщение проходит через ядро от входа к выходу.

- [x] Host: inbound/outbound очереди на SQLite (M) — `src/host/queue/store.ts`
- [x] Петля оркестратора: забор из очереди → вызов LLM → ответ в очередь (L) — `src/host/orchestrator/loop.ts`, LLM-клиент `src/llm/client.ts`
- [x] Audit log (append-only, tamper-evident) (S) — `src/host/audit/log.ts` (hash chain + `verifyChain()`)
- [x] Конфиг и запуск процесса (S) — `src/host/main.ts`, `npm start`, `aegis.config.example.json`

**DoD:** локально «эхо-агент» принимает сообщение из очереди, зовёт LLM, пишет ответ; каждое действие в audit log — выполнено, e2e-тест `test/integration/echo-loop.test.ts`. **Sprint 1 закрыт.**

---

## Sprint 2 — Канал и авторизация (Фаза 1, часть 2)

**Цель:** агент доступен из Telegram только владельцу.

- [x] Channel Adapter для Telegram (официальный Bot API) (M) — `src/host/adapter/{adapter,telegram-client}.ts`: long polling getUpdates → inbound, outbound → sendMessage; тонкий fetch-клиент без SDK (паттерн ADR-0008)
- [x] Deny-by-default авторизация + pairing владельца (M) — `src/host/adapter/{policy,state}.ts`: `/pair <код>` (код через env `pairing_code_ref`, timingSafeEqual, write-once в `channel_state`); чужим — тихий deny с записью в audit
- [x] Провенанс на входе: пометка «от владельца» vs «недоверенное» (S) — классификатор `policy.ts`; принятое → `provenance='owner'`; пересланное/не-текст — fail-closed deny до Quarantine (Sprint 7)
- [x] Обработка ошибок канала, retry/backoff (S) — экспоненциальный backoff (потолок 30s), 429 → retry_after, 409 Conflict останавливает только receiver, offset в `channel_state` переживает рестарт

**DoD:** владелец пишет боту в Telegram и получает ответ; чужие сообщения отклоняются; провенанс проставляется на каждом входящем — выполнено, e2e-тест `test/integration/telegram-adapter.test.ts`. **Sprint 2 закрыт.**

---

## Sprint 3 — Sandbox и Broker (Фаза 1, часть 3)

**Цель:** исполнение и секреты вынесены за границу ОС.

- [x] Sandbox исполнения (Docker): deny-all egress, allowlist mount, non-root (L) — `src/sandbox/runner.ts` (`DockerSandboxRunner`): hardened-профиль ADR-0006 как константы (cap-drop ALL, no-new-privileges, uid 65534, read-only rootfs + tmpfs /tmp noexec, memory/pids/cpus-лимиты, skillDir ro-mount); пустой `allowedHosts` → `--network none`
- [x] Credential Broker (локальный proxy): proxy-инжекция, агент не видит ключ (L) — готовый компонент: Envoy (>= v1.36) с фильтром `credential_injector` (Generic credential, SDS-секрет из файла только у брокера, `401` без креда), конфиг `deploy/broker/envoy.yaml`; TLS origination на брокере — sandbox говорит plain HTTP, MITM-CA не нужен
- [x] Трафик sandbox только через broker-proxy (M) — сети `aegis-internal` (internal: true, deny-all по отсутствию маршрута) + `aegis-egress` в `deploy/docker-compose.yml`; broker — единственный член обеих; allowlist хостов = маршруты Envoy (неизвестный Host → 404)

**DoD:** тест V2 (агент не достаёт сырой секрет ни в одной точке) и V3 (код в sandbox не выходит в сеть мимо broker и не читает хост) — проходят: `test/security/v2-secret-exfiltration.test.ts` (5 проверок, включая `envoy --mode validate` прод-конфига) и `v3-sandbox-escape.test.ts` (7 проверок, негатив + позитивный контроль); контур `npm run test:security` (требует Docker, отдельный CI-шаг). **Sprint 3 закрыт.**

---

## Sprint 4 — Гейт действий (Фаза 1, финал)

**Цель:** каждое действие проходит через градуированный гейт, fail-closed.

- [x] Gate engine: классы read-only / обратимое / необратимое (M) — `src/host/gate/{actions,engine}.ts`: реестр `ACTIONS`, чистая `evaluate()` с `actionClass` read-only|reversible|irreversible → `allow`|`deny`|`confirm_required`
- [x] Провенанс как гейт полномочий (недоверенные данные не инициируют tool-call) (M) — только `owner` инициирует внешний эффект; `quarantine`/`background`/`scheduler` → deny на reversible/irreversible; read-only допускает `system`
- [x] Fail-closed поведение при недоступности проверки/broker (S) — `GateDeps { brokerAvailable, gateHealthy }`: unhealthy gate → deny всё; `sandbox.run` при broker down → deny
- [x] Human-gate для необратимых действий (подтверждение в чате) (S) — `PendingStore` + миграция `0003-queue.sql`; `/test-irreversible` → outbound «/approve TOKEN»; adapter принимает `/approve` → `approved_action` inbound → orchestrator с `confirmed: true`

**DoD:** read-only идёт свободно; необратимое требует подтверждения; при «упавшем» валидаторе действие отклоняется — выполнено: юнит-тесты `test/unit/gate.test.ts`, `test/unit/pending.test.ts`; e2e `test/integration/gate-loop.test.ts`. **Веха: скелет с границами готов. Sprint 4 закрыт.**

---

## Sprint 5 — Память (Фаза 2, часть 1)

**Цель:** агент помнит и ищет без LLM.

- [x] Эпизодическая память: запись сессий + полнотекстовый поиск (M) — `src/memory/episodes.ts` (`EpisodeStore`: append, FTS bm25 search); автозапись owner/assistant после успешного LLM
- [x] Семантическая память: запись знаний со статусами и provenance (M) — `src/memory/knowledge.ts` (`KnowledgeStore`: insert, listForInjection); `/remember <title> | <body>` → unverified owner knowledge
- [x] Инжекция verified/corroborated знаний в системный контекст (M) — `src/memory/context.ts` + gate `memory.read` перед inject; `/search <query>` — FTS без `llm.invoke`

**DoD:** агент находит прошлые сессии поиском без вызова LLM; знания хранятся со статусом и источником — выполнено: `test/integration/memory-loop.test.ts`, unit `test/unit/{episodes,knowledge,context}.test.ts`. **Sprint 5 закрыт.**

---

## Sprint 6 — Обучение и курация (Фаза 2, финал)

**Цель:** знание проходит верификацию, память не отравляется и не пухнет.

- [x] Promotion-гейт: corroborated автоматически, verified для необратимого (M) — `src/memory/promotion.ts`, `/corroborate`, `/verify`
- [x] Детерминированная проверка знаний (тест/повтор наблюдения → corroborated) (M) — `src/memory/verifier.ts` (`tryAutoCorroborate`)
- [x] Курация: staleness, usage, дедуп, decay (M) — `src/memory/curation.ts`, `/curate`
- [x] Snapshot/rollback перед мутациями хранилища (S) — `src/memory/snapshot.ts` (`VACUUM INTO`)

**DoD:** тест V4 (знание из недоверенного источника не попадает в контекст без промоушена) проходит; воспроизводимое знание становится corroborated без владельца — выполнено: `test/security/v4-memory-poisoning.test.ts`, `test/integration/promotion-loop.test.ts`. **Sprint 6 закрыт.**

---

## Sprint 7 — Карантин входа (Фаза 3)

**Цель:** недоверенный контент не может инициировать действие.

- [x] Quarantine-плоскость: Q-LLM без доступа к инструментам (L) — `src/host/quarantine/processor.ts`, `config.llm.q_llm`
- [x] Правило «недоверенные данные входят в рассуждение, но не запускают tool-call в том же ходе» (M) — `handleQuarantineTurn`, gate deny quarantine на effects
- [x] Обработка пересланного контента, веб-страниц, вложений (M) — `extractUntrustedBody`, forward/caption → quarantine queue

**DoD:** тест V1 (prompt injection из пересланного письма не приводит к вызову инструмента) проходит; free-text «прочитай и порассуждай» работает — выполнено: `test/security/v1-prompt-injection.test.ts`, `test/integration/quarantine-loop.test.ts`. **Sprint 7 закрыт.**

---

## Sprint 8 — Навыки (Фаза 4, часть 1)

**Цель:** агент расширяется навыками-данными безопасно.

- [x] Декларативные навыки: markdown + capability-манифест (M) — `src/skills/{types,validate,registry}.ts`, `skills/echo-procedure/`, ADR-0007 zod + семантика
- [x] Прогрессивное раскрытие (list → view) (S) — `/skills`, `/skill <name>`, inject `## Available skills` в system prompt
- [x] Навыки с кодом через sandbox + verifiable loop (dry-run → corroborated) (L) — `SkillDryRun`, `/skill-dry-run`, gate `skillActionClass`
- [x] Установка из git с pinned-версией; скан agent-created кода (M) — `SkillInstaller`, `scanner.ts` denylist; `/skill-install` owner-only

**DoD:** декларативный навык применяется; код-навык проходит dry-run в sandbox перед допуском; `curl|bash` и runtime-install в хосте невозможны. 159 unit/integration-тестов; e2e — `test/integration/skills-loop.test.ts`.

---

## Sprint 9 — Автоматизации и бюджет (Фаза 4 финал + Фаза 5, часть 1)

**Цель:** расписания работают, токены под контролем.

- [x] Scheduler: cron-задачи как сообщения во входную очередь (M)
- [x] Budget engine: дневной лимит, приоритет интерактива над фоном (M)
- [x] Явная деградация при исчерпании + уведомление владельцу (S)

**DoD:** cron-задача наследует те же гейты, что обычный ввод; тест V7 (исчерпание бюджета даёт уведомление + деградацию, не тихий сбой) проходит. 171 unit/integration-тест; e2e — `test/integration/budget-loop.test.ts`.

---

## Sprint 10 — Метрики, закалка, релиз MVP (Фаза 5 финал)

**Цель:** MVP пригоден к самостоятельному развёртыванию.

- [x] Метрика reuse_rate + отключение бесполезного self-improvement (M)
- [x] Прогон всех тестов из [`MVP_SCOPE.md`](MVP_SCOPE.md) (критерии готовности) (M)
- [x] Проверка размера ядра против цели ~4K LOC (S)
- [x] Документация по развёртыванию self-hosted (M)

**DoD:** все критерии готовности MVP из `MVP_SCOPE.md` отмечены; владелец может развернуть агента по [`DEPLOYMENT.md`](DEPLOYMENT.md). **Веха: MVP.** 177 unit/integration-тестов; e2e — `test/integration/metrics-loop.test.ts`.

---

## После MVP (бэклог, без спринтов)

- Дополнительные каналы (по одному, только официальные API)
- Вынос broker на отдельный хост / micro-VM для sandbox
- 2FA / out-of-band подтверждение необратимых действий
- LLM-консолидация памяти (сверх детерминированной курации)
- Мульти-модельные конфигурации (P-LLM / Q-LLM разных провайдеров)

---

## Сводка

| Спринт | Фаза                          | Веха               |
| ------ | ----------------------------- | ------------------ |
| 0      | Проектирование                | решения закрыты    |
| 1–4    | Скелет с границами            | **границы готовы** |
| 5–6    | Память и обучение             |                    |
| 7      | Карантин входа                |                    |
| 8–9    | Навыки, автоматизации, бюджет |                    |
| 10     | Экономика и релиз             | **MVP**            |

Ориентир: ~10 спринтов ≈ 20 недель до MVP для команды 1–3 человека. Оценки уточняются после Sprint 0.
