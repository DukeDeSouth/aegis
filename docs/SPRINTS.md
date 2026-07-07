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

## Sprint 11 — История диалога + active recall (Post-MVP, F1)

**Цель:** P-LLM видит последние N реплик и релевантные эпизоды без потери плана между сообщениями.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F1

- [x] `EpisodeStore.tailBySession` — хвост диалога ASC (S)
- [x] `buildSessionContext` в `context.ts` — tail + FTS recall + knowledge (M)
- [x] Конфиг `memory.context.{enabled, dialog_tail, recall_k, max_tokens}` (S)
- [x] Orchestrator: multi-turn `messages[]` в `llm.complete` (M)
- [x] UNTRUSTED wrap для quarantine episodes в recall/хвосте (S)
- [x] Token budget trim с eviction recall → tail → knowledge (M)

**DoD:** владелец ссылается на реплику 5+ сообщений назад — агент отвечает без повторного объяснения; active recall без LLM на этапе подбора; `npm run test:security` зелёный; расширение V4 для recall path. E2e — `test/integration/context-loop.test.ts`. **Sprint 11 закрыт.**

---

## Sprint 12 — Web-fetch через broker + карантин (Post-MVP, F2)

**Цель:** `/fetch <url>` загружает страницу через sandbox+broker, выжимка проходит Q→P.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F2

- [x] Gate `web.fetch` (read-only, requiresBroker, quarantineRequired)
- [x] SSRF-валидация URL в ядре (`validateFetchUrl`)
- [x] `SandboxWebFetcher` + `skills/web-fetch/fetch.sh`
- [x] `web_cache` (миграция `0002-memory.sql`)
- [x] `/fetch` → `handleQuarantineTurn` (source `web`)
- [x] Конфиг `web.{max_response_kb, cache_ttl_s, broker_host}`

**DoD:** `/fetch https://…` → quarantine pipeline; V1 injection со страницы не вызывает sandbox.run; SSRF блокируется; e2e `test/integration/fetch-loop.test.ts`. **Sprint 12 закрыт.**

---

## Sprint 13 — Стартовые навыки (Post-MVP, F3)

**Цель:** свежая установка полезна без маркетплейса — 4 декларативных навыка + команды оркестратора.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F3

- [x] `skills/web-digest` — источники в SKILL.md, `/digest` + cron
- [x] `skills/reminders` — `/remind HH:MM`, `ReminderStore` + tick scheduler
- [x] `skills/memory-search` — `/summarize <query>` (FTS + один `llm.invoke`)
- [x] `skills/agent-status` — `/status` (metrics + budget + pending + skills)
- [x] Миграция `0005-queue.sql` (`reminders`)

**DoD:** новые навыки проходят `SkillRegistry`/`validate`; e2e `test/integration/starter-skills-loop.test.ts`; без новых gate-классов. **Sprint 13 закрыт.**

---

## Sprint 14 — Workspace (Post-MVP, F4)

**Цель:** безопасные file.read/file.write в выделенной директории + rw-mount для sandbox.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F4

- [x] Gate `file.read` (read-only), `file.write` (reversible)
- [x] `WorkspaceStore` — path validation (realpath), trash backup, undo
- [x] Команды `/read`, `/write path | content`, `/undo-file`, `/delete-file`
- [x] Конфиг `sandbox.workspace_dir`; Docker rw-mount `/workspace`
- [x] V3: workspace mount + unit path escape

**DoD:** цикл write→read→undo; traversal/symlink блокируются; e2e `test/integration/workspace-loop.test.ts`. **Sprint 14 закрыт.**

---

## Sprint 15 — Draft-навыки из эпизодов (Post-MVP, F5)

**Цель:** верифицируемый learning loop — детектор повторов → draft → owner accept/reject.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F5

- [x] `SkillProposalRunner` — сигнатура сессий, порог ≥3 за 14 дней
- [x] Черновики в `skills/.drafts/` (не в system prompt)
- [x] `validateNeedsSubset` + scanner + manifest validate
- [x] `/curate` запускает детектор; `/skill-review|accept|reject`
- [x] Миграция `0006-memory.sql`; `learning.skill_proposal_threshold`

**DoD:** propose → accept → skill в registry; V4 draft isolation; e2e `test/integration/skill-proposal-loop.test.ts`. **Sprint 15 закрыт.**

---

## Sprint 16 — Skill Curator (Post-MVP, F6)

**Цель:** детерминированный грейдинг навыков — метрики, отчёт, archive с откатом.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F6

- [x] `skill_metrics` (invocations, successes, last_used_at) — миграция `0007-memory.sql`
- [x] `SkillCurator` — stale / low success-rate / duplicates
- [x] `/curate-skills`, `/skill-archive`, `/skill-unarchive` (snapshot перед archive)
- [x] Skill reuse в `/metrics`
- [x] Конфиг `learning.skill_curator_stale_days`, `skill_curator_min_success_rate`

**DoD:** archive → навык вне `/skills` и prompt; unarchive восстанавливает; e2e `test/integration/skill-curator-loop.test.ts`. **Sprint 16 закрыт.**

---

## Sprint 17 — Импорт SKILL.md (Post-MVP, F7)

**Цель:** совместимость с agentskills.io / SKILL.md без маркетплейса.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F7

- [x] `importExternalSkill` — frontmatter → manifest ADR-0007, infer capabilities из тела
- [x] `requires_review` при пустых caps / risky-паттернах / без description
- [x] `SkillInstaller` — SKILL.md-only репозитории, scanner до установки
- [x] `SkillRegistry.reviewApproved` — навык не в prompt до `/skill-approve`
- [x] Fixture-набор + security: risky body → scanner block

**DoD:** `/skill-install` внешнего навыка → review → approve → в prompt; e2e `test/integration/skill-import-loop.test.ts`. **Sprint 17 закрыт.**

---

## Sprint 18 — MCP через gate (Post-MVP, F8)

**Цель:** внешние MCP-tools с fail-closed маппингом и quarantine ответов.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F8

- [x] Config `mcp.servers[]` — stdio transport, tool → action_class
- [x] Динамический gate `mcp.<server>.<tool>`; немаппленный tool = deny
- [x] `StdioMcpClient` + `/mcp` → Q→P (`source: mcp`)
- [x] Sandbox stdio bridge (`server_dir`, Node image)
- [x] Irreversible MCP → `pending_actions` / `/approve`
- [x] Env isolation (V8); V1 MCP injection test

**DoD:** owner `/mcp` end-to-end; unmapped denied; irreversible pending; e2e `test/integration/mcp-loop.test.ts`. **Sprint 18 закрыт.**

---

## Sprint 19 — Установка одной командой (Post-MVP, F9)

**Цель:** `npx aegis-setup` — визард без `curl|bash`, вне LOC ядра.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F9

- [x] `packages/aegis-setup` — `init`, `verify`, `upgrade`
- [x] Генерация config, env, compose, broker templates, pairing code
- [x] Bundled `deploy/broker` templates
- [x] Unit-тесты пакета; root workspace

**DoD:** `aegis-setup init --yes` + `verify` на свежем clone. **Sprint 19 закрыт.**

---

## Sprint 20 — Дополнительные каналы (Post-MVP, F10)

**Цель:** Discord + email-as-input поверх `ChannelAdapter` без изменений оркестратора.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F10

- [x] `ChannelAdapter` + session prefixes (`tg:` / `discord:` / `email:`)
- [x] `DiscordAdapter` — Gateway v10, DM-only, `/pair`, stranger deny, outbound
- [x] `EmailInputAdapter` — unconditional quarantine (`source: email`)
- [x] Миграция `0008-queue.sql` — discord/email keys в `channel_state`
- [x] E2E: `discord-adapter.test.ts`, `email-adapter.test.ts`; unit `discord-policy.test.ts`

**DoD:** pairing + quarantine path без правок orchestrator; 250 тестов; LOC 7293/7500. **Sprint 20 закрыт.**

---

## Sprint 21 — Read-only web-дашборд (Post-MVP, F11)

**Цель:** наблюдаемость в браузере без поверхности записи.

**Спека:** [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F11

- [x] `packages/aegis-dashboard` — отдельный процесс, `readonly` SQLite
- [x] Bind `127.0.0.1:8787`; `GET /` only; CSP headers
- [x] Очереди, pending, audit chain, budget, reuse, skills, curation
- [x] Подсказки `/approve <token>`; XSS escape для карантина
- [x] Тесты ro + XSS + HTTP; CI `dashboard:test`

**DoD:** полная картина состояния без SSH; write surface = 0. **Sprint 21 закрыт.**

---

## После MVP (бэклог)

Спринты 17+ — см. [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) (F7–F11).

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
| 11     | Post-MVP F1: контекст диалога |                    |
| 12     | Post-MVP F2: web-fetch        |                    |
| 13     | Post-MVP F3: стартовые навыки |                  |
| 14     | Post-MVP F4: workspace        |                  |
| 15     | Post-MVP F5: draft-навыки     |                  |
| 16     | Post-MVP F6: Skill Curator    |                  |
| 17     | Post-MVP F7: импорт SKILL.md  |                  |
| 18     | Post-MVP F8: MCP через gate   |                  |
| 19     | Post-MVP F9: aegis-setup      |                  |
| 20     | Post-MVP F10: Discord + email |                  |
| 21     | Post-MVP F11: dashboard       |                  |

Ориентир: ~10 спринтов ≈ 20 недель до MVP для команды 1–3 человека. Оценки уточняются после Sprint 0.
