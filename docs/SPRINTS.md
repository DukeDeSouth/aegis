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

## Sprint 22 — MCP через broker: HTTP-транспорт (Connectors, P-A)

**Цель:** MCP-серверы подключаются по HTTP через broker; токены инжектит Envoy, ядро и sandbox их не видят.

**Спека:** [`CONNECTORS.md`](CONNECTORS.md) § P-A | хвост F8 ([`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F8)

- [x] `mcpServerSchema`: discriminated union `stdio` | `http` (`broker_host` + `host` + `path`) (S)
- [x] `HttpMcpClient` в `src/mcp/http-transport.ts` — Streamable HTTP (initialize → initialized → tools/call, `Mcp-Session-Id` echo), Host-паттерн web-fetch, без auth-параметров в принципе (M)
- [x] `HttpMcpRunner` + `DelegatingMcpRunner` ветвится по transport; gate `mcp.<server>.<tool>` без изменений (S)
- [x] Broker-шаблон: virtual_host + cluster для MCP-апстрима (deploy + aegis-setup templates, идентичны) (M)
- [x] Security: V2/V8-расширение — strict schema отклоняет `token`/`headers`; клиент не шлёт auth-заголовков (негативный тест на захваченных заголовках); injection в HTTP-ответе → V1-путь (M)

**DoD:** `/mcp` к HTTP-серверу работает end-to-end через broker-паттерн; конфиг с токеном отклоняется схемой; V1/V2/V8-расширения зелёные; e2e `test/integration/mcp-http-loop.test.ts`. 259 тестов + security 23/23; LOC 7467/7500. **Sprint 22 закрыт.**

---

## Sprint 23 — Каталог коннекторов: волна без OAuth (C2, C3, C6, C7)

**Цель:** формат `connectors/` + `aegis-setup connector add`; поиск, погода, RSS, workspace-заметки из коробки.

**Спека:** [`CONNECTORS.md`](CONNECTORS.md) § P-C, C2, C3, C6, C7

- [x] Формат пресета `connectors/<name>/` (connector.json + SKILL.md + manifest.json; broker-маршруты декларативно в connector.json) (M)
- [x] `aegis-setup connector add|list` — установка навыка + идемпотентная вставка envoy-маршрутов (маркер `# connector:<name>`), config_hints (M)
- [x] C2: SearXNG-пресет + `/research <q>` в ядре — rewrite в `/fetch` по `web.search_url` (`{query}`-шаблон), тот же SSRF/cache/quarantine-путь (M)
- [x] C3: погода — декларативный навык на `web.fetch` (Open-Meteo, без ключа), TLS-маршрут через broker (S)
- [x] C6: RSS/Atom-выжимка (`title — link`) в `skills/web-fetch/fetch.sh` (sandbox, не ядро); источники в SKILL.md (M)
- [x] C7: заметки в workspace — декларативный навык `network:none` поверх `/read`, `/write`, `/undo-file` (S)
- [x] `verify`: проверка `connector-routes` (unpaired marker / route без cluster → FAIL)
- [x] Тесты: `connector.test.ts` (add/list/идемпотентность/битый маршрут), `connector-presets.test.ts` (манифесты по ADR-0007), `web-fetch-script.test.ts` (HTML/RSS/Atom), e2e `research-loop.test.ts` (V1-инъекция в результатах поиска)

**DoD:** `aegis-setup connector add weather search rss` ставит навыки + маршруты идемпотентно; `/research` работает end-to-end через quarantine; ни одного нового gate-класса; `verify` ловит битый маршрут. 272 теста + security 23/23; aegis-setup 12; LOC 7500/7500 (ровно бюджет). **Sprint 23 закрыт.**

---

## Sprint 24 — OAuth у broker + Google Workspace (P-B, C1)

**Цель:** OAuth-refresh sidecar в trust-домене broker; Gmail + Calendar end-to-end; «утренний брифинг».

**Спека:** [`CONNECTORS.md`](CONNECTORS.md) § P-B, C1

- [x] ADR-0010: OAuth-refresh sidecar — свой мини-процесс ~90 строк stdlib (готовые кандидаты — downstream-auth либо требуют креды себе) (M)
- [x] Sidecar `deploy/broker/oauth-sidecar/sidecar.mjs`: refresh-token в файле только у sidecar → access-token в SDS-yaml атомарно (tmp+rename, hot-reload Envoy без рестарта); retry/backoff, ONE_SHOT для тестов (L)
- [x] C1-пресет `connectors/google/`: свой тонкий stdio-MCP `server/server.mjs` в sandbox (7 tools; list/get/search/calendar_list — read-only; draft/calendar_create — reversible; send — irreversible → `/approve`); отдельный listener :8081 с собственным SDS-секретом (`broker_listener` в connector.json, вставка по якорю `listeners:` c маркером `# connector:google listener`) (M)
- [x] Брифинг: композиция C1+C3+C6+reminders cron-hints в `connector add google` + процедура в SKILL.md — ноль кода ядра (S)
- [x] Security: V2/OAuth — strict-схема ядра отвергает поля токенов; код server/sidecar не выставляет Authorization и не логирует токены; e2e-assert «запрос к broker без кредов» (M)

**DoD:** `/mcp google calendar_list` («что у меня сегодня») и `/approve`-отправка письма работают e2e с фейковым Google API; sidecar против фейкового token-endpoint; merged envoy.yaml (weather+search+google) прошёл `envoy --mode validate` v1.37.1; ядро не тронуто — LOC 7500/7500. 289 тестов + security 25/25 + aegis-setup 16; typecheck ядра чист (попутно вылечен долг: `estimated`/learning-поля в старых тестах, `requires_review` exactOptionalPropertyTypes). **Sprint 24 закрыт.**

---

## Sprint 25 — Home Assistant + GitHub (C4, C5)

**Цель:** два коннектора с эталонной градуировкой классов.

**Спека:** [`CONNECTORS.md`](CONNECTORS.md) § C4, C5

- [x] C4: HA-пресет — get_state read-only; свет/климат reversible; замки/сигнализация irreversible → `/approve` (M)
- [x] C5: GitHub-пресет — чтение read-only; issue/comment reversible; merge/close irreversible (M)
- [x] Long-lived токены (HA, fine-grained PAT) в секрет-файле broker (S)
- [x] Security: unlock без `/approve` невозможен (негативный тест); injection из issue-текста → V1 (M)

**DoD:** оба пресета ставятся через `connector add`; unlock-негатив зелёный; e2e на каждый коннектор.

---

## Sprint 26 — Бытовые фичи и хвосты (C8, IMAP, connector upgrade)

**Цель:** закрыть «пищат юзеры»-разрывы, которые дёшевы на готовых рельсах, и хвосты волны 1.

**Спека:** [`CONNECTORS.md`](CONNECTORS.md) § C8, P-C | хвост F10 ([`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) § F10)

- [x] C8: price tracker / мониторинг страниц — детерминированный diff в sandbox-скрипте `watch.sh` (сравнение с workspace snapshot), пресет `connectors/watch` + cron-hint; `/watch` в ядре (ADR-0012); «страница изменилась / цена ниже порога → уведомление» (M)
- [x] IMAP-fetcher для email-канала: `deploy/broker/imap-bridge/` + `BrokerHttpEmailFetcher`; wiring в `main.ts`; ADR-0012 LOC 7650 (L)
- [x] `aegis-setup connector upgrade` — переустановка пресета с diff (маркерные блоки envoy заменяются, навык обновляется, `verify` после) (M)
- [x] `verify`: smoke-проверка живого broker — «401 без креда на OAuth-listener, 404 на неизвестный Host» (опционально, если broker поднят) (S)
- [x] Onboarding самообучения: `aegis-setup init`/README явно подсказывают включить `learning.self_improvement_llm_enabled` — иначе главный дифференциатор (F5) молчит по умолчанию (S)
- [x] MIME encoded-words (не-ASCII темы) в `connectors/google/server/server.mjs` (S)

**DoD:** письмо доходит в prod-конфигурации IMAP→quarantine→P e2e (фейковый IMAP); «цена изменилась» приходит по cron e2e; `connector upgrade` идемпотентен и показывает diff; V1/V2-контур зелёный на новых путях.

---

## Sprint 27 — Out-of-band подтверждение необратимых действий (2FA-approve)

**Цель:** превратить `/approve` из чат-команды в реальный второй фактор — публично различимое security-преимущество над обоими конкурентами.

**Спека:** [`THREAT_MODEL.md`](THREAT_MODEL.md) (сценарий «компрометация канала владельца») | **M7:** [`m7-cycles/sprint-27-2fa-approve-out-of-band-second-factor-gate/`](../m7-cycles/sprint-27-2fa-approve-out-of-band-second-factor-gate/)

- [x] ADR-0011: пересмотр LOC-порога под security-фичу ядра (gate/pending) — точечное поднятие с перечнем включённого (S)
- [x] Механизм: подтверждение irreversible-действий из **второго** paired-канала (Telegram ↔ Discord) и/или TOTP-код; конфиг `gate.second_factor` (какие классы требуют, дефолт — все irreversible) (L)
- [x] Захваченный канал ≠ полный контроль: негативный тест «approve из того же канала, что и команда, отклоняется при включённом second_factor» (M)
- [x] Дашборд: pending-подсказка показывает, из какого канала ждём подтверждение (S)

**DoD:** `gmail_send` при включённом second_factor требует подтверждения из другого канала; компрометация одного канала не даёт выполнить необратимое действие (негативный тест, расширение security-контура V9); дефолт — выключено (без второго канала поведение прежнее).

---

## Sprint 28 — Волна 2: финансы read-only + заметки-сервисы (C9, C7-CalDAV/Notion)

**Цель:** достроить домашние сценарии поверх C1 и workspace.

**Спека:** [`CONNECTORS.md`](CONNECTORS.md) § C9, C7 | **M7:** [`m7-cycles/sprint-28-волна-2-c9-финансы-read-only-c7-caldav-c/`](../m7-cycles/sprint-28-волна-2-c9-финансы-read-only-c7-caldav-c/)

- [x] C9: детект счетов/сумм из C1-почты (детерминированные паттерны в sandbox), журнал расходов в `workspace/finance/`, месячный отчёт по cron; движение денег **не маппится** (позиционная граница) (M)
- [x] C7-CalDAV: пресет Nextcloud Tasks/Calendar (self-hosted ЦА) — Basic-auth у broker, классы read/append/delete по эталону (M)
- [x] C7-Notion: MCP-пресет поверх P-A (HTTP-транспорт) + OAuth-sidecar при необходимости (M)
- [x] Google Drive: +2–3 read-only tools в `connectors/google/server` (list/search/get текстовых файлов) (S)
- [x] Решение по C10 (n8n) и C11 (Playwright) — по метрикам использования волны 1–2; зафиксировать в CONNECTORS.md (S)

**DoD:** «сколько я потратил в этом месяце» отвечает из журнала; CalDAV/Notion ставятся через `connector add` за ≤10 минут; ни одного нового gate-класса; V1/V2-паттерн-тесты на каждый пресет.

---

## Sprint 29 — Matrix-канал (C12) + go/no-go C10/C11

**Цель:** третий paired control-канал владельца (privacy-ЦА) и формальное решение по отложенным C10/C11.

**Спека:** [`CONNECTORS.md`](CONNECTORS.md) §C12, §C10–C11 | [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) §F10 (продолжение)

**Критерий старта C10/C11 в этом спринте:** только если до начала кодинга выполнены метрики Sprint 28 (см. ниже); иначе — Matrix only, C10/C11 → Sprint 30+.

- [ ] ADR-0014: LOC-порог под `MatrixAdapter` (если ядро растёт) (S)
- [ ] `MatrixAdapter` на `ChannelAdapter`: Client-Server API (`/sync` long-poll), DM-only в v1 (M)
- [ ] Pairing write-once (как Discord/Telegram); `session_id` префикс `matrix:` в очереди (M)
- [ ] Интеграция с Sprint 27: `gate.second_factor` cross-channel TG/Discord ↔ Matrix (S)
- [ ] Credential homeserver + access token **только у broker** или env ref в trust-домене хоста — не в sandbox (M)
- [ ] `aegis-setup`: hints для Matrix (homeserver URL, pairing) (S)
- [ ] Go/no-go **C10 n8n**: ≥3 активных коннектора на эталонной установке + user-story → зафиксировать в CONNECTORS.md (S)
- [ ] Go/no-go **C11 Playwright**: gap в research/watch (audit/dashboard) → зафиксировать в CONNECTORS.md (S)
- [ ] Тесты: unit adapter + integration loop; V1 injection в room event (M)

**DoD:** paired Matrix DM → диалог с агентом; unpaired → deny; irreversible + 2FA on → approve из другого канала; setup документирован ≤10 мин; решение C10/C11 записано (go с ADR или defer Sprint 30+).

---

## После MVP (бэклог)

Спринты 17+ — см. [`POST_MVP_FEATURES.md`](POST_MVP_FEATURES.md) (F7–F11).

- Дополнительные каналы (Slack, Signal — по одному, только официальные API; Matrix — Sprint 29)
- Вынос broker на отдельный хост / micro-VM для sandbox
- LLM-консолидация памяти (сверх детерминированной курации)
- Мульти-модельные конфигурации (P-LLM / Q-LLM разных провайдеров)
- C10 n8n-мост, C11 Playwright-автоматизация — go/no-go в Sprint 29, реализация Sprint 30+ при defer

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
| 22     | Connectors P-A: MCP через broker (HTTP) |        |
| 23     | Connectors: волна без OAuth (C2/C3/C6/C7) |      |
| 24     | Connectors: OAuth sidecar + Google (C1) |        |
| 25     | Connectors: Home Assistant + GitHub (C4/C5) |    |
| 26     | Бытовые фичи: price tracker, IMAP, upgrade (C8) | email-канал живой |
| 27     | 2FA-approve: out-of-band подтверждение |  **security-дифференциатор** |
| 28     | Connectors волна 2: финансы, CalDAV/Notion (C9/C7) | паритет+ |
| 29     | Matrix-канал (C12) + go/no-go C10/C11           | privacy-канал |

Ориентир: ~10 спринтов ≈ 20 недель до MVP для команды 1–3 человека. Оценки уточняются после Sprint 0.
