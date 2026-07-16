# Connectors — каталог целевых интеграций и модель их идеальной реализации

> Источник: анализ рынка (июль 2026) — рейтинги MCP-серверов (Apigene, Toloka, официальный registry), топ навыков OpenClaw/ClawHub, интеграции Hermes Agent, публичные self-hosted сборки персональных агентов.
> Статус: спецификация (аналог `POST_MVP_FEATURES.md` для волны C1–C12). Ни один коннектор не имеет права ослабить инварианты V1–V8 (`THREAT_MODEL.md`).

## Что показал рынок

1. **7 из 10 топ-навыков OpenClaw — коннекторы к внешним сервисам**, не standalone-функции. Пользователи ценят connectivity выше «умности» агента.
2. **Самые устанавливаемые категории** (по установкам ClawHub + MCP registry): погода (№1 OpenClaw), Google Workspace (Gmail+Calendar+Drive — 75k+), web-search (Tavily 71k+, Brave — «essential»), GitHub, Home Assistant / smart home, price tracking, заметки (Notion/Obsidian), n8n-мост.
3. **Практика MCP-экосистемы**: продакшен-сетапы подключают 3–7 серверов, не десятки; «tier-1» серверов ~50, остальные тысячи — свалка с риском supply chain (урок ClawHub: 800+ вредоносных навыков).
4. **Боль №1 — авторизация.** Взлёт агрегаторов managed-OAuth (Composio: «1000+ инструментов без своей auth», API Gateway: «100+ API с managed OAuth»). Пользователи готовы отдать токены третьей стороне, лишь бы не настраивать OAuth руками.
5. **Домашний спрос** (self-hosted сборки 2026): утренний брифинг (погода+календарь+почта+задачи), почтовый триаж, счета/бюджет из почты, контроль умного дома, дайджесты источников.

**Вывод для AEGIS.** Пункт 4 — одновременно и главный спрос, и главная уязвимость конкурентов: токены Gmail/календаря/банка в чужом облаке или в env агента. Ниша AEGIS «агент, которому можно доверить секреты» здесь конвертируется в продуктовое отличие: **тот же комфорт подключения, но токены физически не покидают broker владельца**. Коннекторы — не отступление от security-модели, а её витрина.

---

## Модель коннектора (одна для всех)

Коннектор в AEGIS — это **не код в ядре**. Это декларативный пресет из четырёх частей:

```
connectors/<name>/
├── connector.json    # pinned MCP-сервер (образ/версия), transport, tool → action_class
├── broker.yaml       # фрагмент Envoy-маршрута: allowlist хостов + credential_injector
├── SKILL.md          # декларативный навык: команды владельца, процедуры (ADR-0007)
└── manifest.json     # capability-манифест навыка (needs ⊆ tools коннектора)
```

Путь любого вызова: `owner command → gate (mcp.<server>.<tool>, fail-closed) → MCP-сервер в sandbox (нет egress, нет секретов) → HTTP через broker (Envoy инжектит токен) → ответ → provenance='quarantine'/'tool' → Q→P`. Это существующие механизмы Sprint 18 (F8) + Sprint 3 (broker); нового привилегированного пути нет.

**Сквозные правила:**

- **Deny-by-default**: коннектор выключен, пока владелец не выполнил `aegis-setup connector add <name>` (кладёт конфиг + секрет в broker, показывает diff).
- **Немаппленный tool = deny** (уже инвариант F8); классы фиксируются в пресете, а не выводятся динамически.
- **Все ответы — недоверенные данные** (V1): содержимое письма/страницы/заметки не может инициировать tool-call в том же ходе.
- **Секреты только у broker** (V2): MCP-процесс получает placeholder; Envoy подставляет реальный токен на маршруте. Никаких токенов в env sandbox.
- **Pinned-версии** MCP-серверов (V6-дисциплина): образ/commit фиксируется в `connector.json`; обновление — явное, через `aegis-setup connector upgrade` с diff.
- **LOC-бюджет**: пресеты — данные; ядро растёт только на HTTP-транспорт MCP (см. «Пререквизиты»).

### Классы действий по типам операций (эталон для пресетов)

| Операция | Класс | Пример |
|---|---|---|
| Чтение (письма, события, состояние устройств, заметки, issues) | read-only | `gmail.list`, `ha.get_state` |
| Создание/изменение с естественным откатом | reversible | `calendar.create_event`, `notion.append`, `ha.light_on` |
| Внешне видимое / необратимое / безопасность | irreversible → `/approve` | `gmail.send`, `github.merge_pr`, `ha.unlock_door` |
| Деньги, торговля, удаление аккаунтов | **не маппится вообще** (deny) | переводы, crypto-трейдинг |

---

## Пререквизиты (блокеры волны коннекторов)

### P-A. HTTP-транспорт MCP через broker — хвост Sprint 18

Сейчас `mcp.transport: 'stdio'` only. Нужно: `transport: 'http'` — вызовы идут на broker с `Host: <upstream>` (паттерн web-fetch F2); Envoy матчит allowlist-маршрут и инжектит токен через `credential_injector`. Ядро: расширение `mcpServerSchema` + HTTP-клиент в `src/mcp/` (переиспользовать паттерн `stdio-transport`). Это единственный существенный рост ядра во всей волне.

**Статус (Sprint 22): реализовано** — `mcpServerSchema` union (`http`: `broker_host`+`host`+`path`), `HttpMcpClient`/`HttpMcpRunner` (Streamable HTTP, session-id echo, без auth-полей по построению), broker-шаблоны с MCP-образцом; V2/V8-расширения + e2e `mcp-http-loop`.

### P-B. OAuth-refresh у broker

Google/Microsoft/Notion живут на OAuth2 с коротким access-token. Идеал: **refresh-петля вне ядра и вне sandbox** — sidecar-процесс рядом с Envoy (тот же trust-домен broker): хранит refresh-token в секрет-файле, обновляет access-token, пишет в SDS-файл Envoy. Агент не участвует и ничего не видит. Первая версия (для HA/GitHub/погоды) может жить на статических long-lived токенах — OAuth-sidecar нужен к волне C1.

**Статус (Sprint 24): реализовано (ADR-0010)** — `deploy/broker/oauth-sidecar/sidecar.mjs` (~90 строк stdlib, без npm): refresh-grant → SDS-yaml `inline_string` атомарно (tmp+rename → hot-reload Envoy), retry/backoff, `OAUTH_ONE_SHOT` для тестов/health-check; токены не логируются. Параметризован env'ами (`OAUTH_TOKEN_URL`…) — пригоден для Microsoft/Notion. Так как у `credential_injector` нет per-route секретов, OAuth-маршруты живут на **отдельном listener :8081** со своим SDS-секретом (`broker_listener` в connector.json).

### P-C. `aegis-setup connector add|list|upgrade`

Расширение существующего визарда (вне ядра): копирует пресет, спрашивает секрет (кладёт только в секрет-файл broker), мёржит фрагмент в envoy.yaml и `aegis.config.json`, показывает diff, идемпотентно. `verify` дополняется smoke-проверкой маршрута («broker отвечает 401 без креда, 200 с плейсхолдером»).

**Статус (Sprint 23): реализовано (без секретов — волна 1 их не требует)** — `packages/aegis-setup/src/connector.ts`: `connector list` (installed/available), `connector add <name…>` копирует навык в `skills/`, идемпотентно вставляет broker-маршруты (маркер `# connector:<name>`), печатает config_hints; `verify` получил проверку `connector-routes` (битый vhost/cluster → FAIL). Секрет-провижининг и `upgrade` — вместе с P-B (Sprint 24). *(Уточнение Sprint 24: `broker_listener` в connector.json — вставка целого listener-блока по якорю `listeners:`; OAuth-секреты остались файловыми у sidecar — интерактивный визард секретов не понадобился.)*

---

## Каталог: волна 1 (паритет по спросу)

### C1. Google Workspace: Gmail + Calendar (+ Drive позже)

Самый скачиваемый productivity-коннектор рынка (GOG 75k+). Закрывает триаж почты, «что у меня сегодня», создание событий, отправку писем через `/approve`.
- Чтение почты дополняет `EmailInputAdapter` (F10): adapter — пассивный вход, коннектор — активные запросы («найди письмо от X»).
- Классы: `list/get/search` — read-only; `calendar.create/update`, `draft` — reversible; `send` — irreversible.
- Требует P-B (OAuth). Контент писем — quarantine безусловно (правило F10 распространяется).
- **Ответ конкуренту:** GOG/Composio с токенами в чужом облаке vs токены у собственного broker.

**Статус (Sprint 24): реализовано** — `connectors/google`: свой тонкий stdio-MCP `server/server.mjs` (7 tools) в sandbox — готовые Gmail-MCP образы отвергнуты (требуют credentials себе = V2-нарушение). Сервер ходит plain HTTP на `aegis-broker:8081` c `Host: gmail.googleapis.com|www.googleapis.com`; Authorization в коде отсутствует по построению (негативный тест). Классы: `gmail_list/search/get`, `calendar_list` — read-only; `gmail_draft`, `calendar_create` — reversible; `gmail_send` — irreversible → `/approve` (e2e). Брифинг «что у меня сегодня» — cron-hints композиция C1+C3+C6+reminders, без кода ядра. Bootstrap refresh-token — `deploy/broker/oauth-sidecar/README.md`.

### C2. Web search (SearXNG self-hosted / Brave / Tavily)

«Pretty much essential» по всем рейтингам; у нас есть `/fetch`, но нет поиска — заметная дыра в research-сценариях. `/research <query>` = search → top-N → существующий web-fetch pipeline.
- Классы: `search` — read-only, `quarantineRequired` (сниппеты = недоверенный текст).
- Дефолт-пресет — SearXNG в docker (без ключа, приватность); Brave/Tavily — альтернативы с ключом у broker.
- Ядро: ничего нового — MCP-tool + композиция с F2.

**Статус (Sprint 23): реализовано** — `/research <q>` в ядре = rewrite в `/fetch` по `web.search_url` (шаблон с `{query}`, тот же SSRF/cache/quarantine-путь, +15 LOC); пресет `connectors/search` даёт маршрут `searxng.aegis → searxng:8080` (plain HTTP upstream во внутренней сети — реальный egress всегда sandbox→broker по allowlist).

### C3. Погода

№1 по установкам на ClawHub — «нулевая конфигурация, мгновенная полезность». Идеально для брифинга.
- Реализация — вообще без MCP: декларативный навык + `web.fetch` на Open-Meteo (без ключа). Тест модели навыков, как F3.
- Классы: только `web.fetch` (read-only).

**Статус (Sprint 23): реализовано** — `connectors/weather`: TLS-маршрут `api.open-meteo.com`, декларативный навык с процедурой `/fetch …forecast…` и cron-hint.

### C4. Home Assistant

Ядро self-hosted аудитории — нашей ЦА; есть официальный MCP-сервер HA. Локальный API, без облака.
- Маршрут: HA в LAN → route у Envoy → long-lived token в секрет-файле broker.
- Классы — эталон градуировки: `get_state/list` — read-only; свет/климат/медиа — reversible; **замки, сигнализация, гаражные ворота — irreversible → `/approve`**; камеры — read-only с quarantine.
- **Ответ конкуренту:** Smart Home Controller OpenClaw делает unlock без подтверждения — публично различимое преимущество.

### C5. GitHub

Топ-3 всех рейтингов MCP; наша ЦА — технические владельцы. Уведомления, issues, статусы PR/CI.
- Официальный GitHub MCP server, fine-grained PAT у broker.
- Классы: чтение — read-only; `create_issue/comment` — reversible; `merge/close/delete` — irreversible.

### C6. RSS/новости

Достраивает `web-digest` (F3) до полного дайджеста: парсинг фидов вместо голых страниц. Морнинг-брифинг = композиция C3+C6+C1+reminders — сценарий №1 у домашних пользователей.
- Реализация: readability-скрипт web-fetch расширяется RSS/Atom-парсингом (в sandbox, не в ядре); источники — в SKILL.md.

**Статус (Sprint 23): реализовано** — `skills/web-fetch/fetch.sh` детектит `<rss|<feed` и выжимает `title — link` по строке на item (RSS + Atom, CDATA); пресет `connectors/rss` = навык-источники для `/digest` + маршруты фидов.

### C7. Заметки и задачи: workspace-first, CalDAV, Notion

- Первый шаг — **без нового кода**: Obsidian-vault = markdown в `workspace/` (F4 уже даёт read/write/undo/trash) — популярный паттерн «agent + Obsidian».
- CalDAV/Nextcloud Tasks (self-hosted ЦА) и Notion (mainstream) — MCP-пресеты поверх P-A/P-B.
- Классы: read — read-only; append/create — reversible; delete — irreversible.

**Статус (Sprint 23): workspace-шаг реализован** — `connectors/notes`: декларативный навык (`network: none`, `files.read`+`files.write`) с процедурами `/write notes/…`, `/read`, `/undo-file`, конвенциями kebab-case/daily и Obsidian-vault поверх `sandbox.workspace_dir`. **Sprint 28:** `connectors/caldav` (CalDAV :8084 Basic-auth) и `connectors/notion` (integration token :8085).

---

## Каталог: волна 2 (растущий спрос)

### C8. Price tracker / мониторинг страниц

**Статус (Sprint 26):** реализовано — пресет `connectors/watch` (skill-only), `skills/web-fetch/watch.sh` (детерминированный diff + price heuristic в sandbox), `/watch` в ядре (~50 LOC, ADR-0012), cron-hint в connector.json; снимки в `workspace/watch/<hash>.digest`.

Топ-5 OpenClaw. У нас есть всё: scheduler (cron) + web.fetch. Diff-логика: «страница изменилась / цена ниже порога → уведомление».

### C9. Финансы read-only

**Статус (Sprint 28):** реализовано — пресет `connectors/finance` (skill + `parse_finance.sh` / `report_finance.sh` в sandbox); ядро: `/finance-ingest` (MCP `gmail_finance_fetch` → журнал `workspace/finance/`) и `/finance-report` (ADR-0013). Движение денег не маппится.

Спрос подтверждён (бюджет-агенты, счета из почты). Наша версия — принципиально **read-only**: детект счетов/сумм из C1-почты, журнал расходов в workspace, месячный отчёт по cron. Движение денег не маппится (см. эталон классов) — это позиционная граница, а не недоделка.

### C10. Мост n8n/Zapier

**Статус: DEFER (Sprint 29+)** — решение Sprint 28: отложить до метрик волны 1–2. Критерий revisit: ≥3 активных коннектора у установки + явный user-story на webhook-автоматизации.

Один коннектор → 400+ приложений; популярен (52k+ установок у OpenClaw). Риск: за webhook'ом n8n может стоять что угодно, классы не выводимы. Правило: **каждый workflow маппится владельцем отдельно**, дефолт — irreversible; ответы — quarantine. Дёшево (generic HTTP MCP-tool + маршрут), но включать после волны 1.

### C11. Browser automation (Playwright MCP)

**Статус: DEFER (Sprint 29+)** — JS-render покрыт `/fetch` + C8; Playwright — cookie/login surface. Revisit при доказанном gap в research/watch метриках.

№1 по поиску в MCP-экосистеме, но самая опасная поверхность (интерактивные сессии = куки/логины). Если делать: headless-браузер в отдельном sandbox-контейнере, сеть только через broker, только read-сценарии (рендер JS-страниц для C2/C8), никаких логинов в первой версии. Решение об очерёдности — после метрик использования волны 1.

### C12. Каналы Slack / Matrix / Signal

Это продолжение F10 (каналы, не коннекторы) — по одному, только официальные API, поверх `ChannelAdapter`. Приоритет по запросам пользователей; Matrix/Signal резонируют с privacy-ЦА.

**Статус: Sprint 29 (Matrix)** — первый канал волны C12; Slack/Signal — Sprint 30+ по запросу.

## Чего сознательно НЕ делаем

- **Composio-паттерн** (токены в чужом managed-OAuth облаке) — прямое нарушение V2. Наш эквивалент удобства — `aegis-setup connector add` + OAuth-sidecar broker.
- **Crypto-трейдинг / переводы денег** (Crypto Portfolio Monitor OpenClaw торгует автоматически) — необратимые финансовые эффекты от LLM-решений вне модели угроз.
- **Неофициальные API** (WhatsApp-scraping, iMessage-хаки) — баны и MITM-поверхность (позиция ROADMAP).
- **Динамическая установка коннекторов из чата** — только `aegis-setup` на хосте владельцем (инвариант F8 «никакой установки MCP из чата» распространяется).
- **Гонка за количеством**: практика показывает 3–7 активных серверов на установку; цель — 10–12 вылизанных пресетов, не каталог тысяч.

---

## Порядок реализации

| Спринт | Содержимое | Зависимости |
|---|---|---|
| 22 | **P-A**: HTTP-транспорт MCP через broker + token injection; V2/V8-расширения | — (хвост F8) |
| 23 | **P-C** + волна «без OAuth»: C2 (SearXNG), C3 (погода), C6 (RSS), C7-workspace; формат `connectors/` | 22 |
| 24 | **P-B** (OAuth-sidecar) + **C1** Gmail/Calendar; сценарий «утренний брифинг» e2e | 22, 23 |
| 25 | **C4** Home Assistant + **C5** GitHub | 22, 23 |
| 26+ | C8 price tracker, C9 финансы, C7-CalDAV/Notion; далее по метрикам использования | 23–25 |

**Критерий готовности волны 1:** свежая установка → `aegis-setup connector add weather search rss` → утренний брифинг по cron в первый день; Gmail/HA подключаются за ≤10 минут; ни в одной точке (env sandbox, конфиг ядра, логи) не появляется сырой токен — расширенный V2-контур зелёный.

**Тесты (шаблон на каждый пресет):** integration «команда → ответ через quarantine»; security: инъекция в ответе сервиса не инициирует tool-call (V1); токен отсутствует в env MCP-процесса (V2/V8); немаппленный tool → deny; irreversible без `/approve` → pending.
