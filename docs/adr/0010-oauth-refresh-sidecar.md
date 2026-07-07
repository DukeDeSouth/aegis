# ADR-0010: OAuth-refresh sidecar — свой мини-процесс в trust-домене broker

**Status:** Accepted
**Date:** 2026-07-07
**Context:** Sprint 24 (CONNECTORS.md P-B, C1 — Gmail/Calendar)

## Context

OAuth-сервисы (Google) выдают короткоживущий access-token (~1 ч) и долгоживущий
refresh-token. Envoy `credential_injector` умеет инжектить только статичное
значение из SDS — кто-то должен крутить refresh-петлю. По V2 (ADR-0004) ни ядро,
ни sandbox не должны видеть ни refresh-, ни access-token.

## Decision

**Свой мини-процесс** `deploy/broker/oauth-sidecar/sidecar.mjs` (~90 строк,
только node stdlib, без npm-зависимостей), работающий в trust-домене broker
(compose-сосед, та же степень доверия, что Envoy):

- читает `google-oauth.json` (client_id, client_secret, refresh_token) — файл
  смонтирован только ему;
- `POST <token_url>` (grant_type=refresh_token) → `{access_token, expires_in}`;
- атомарно (tmp + rename) пишет SDS-yaml с `inline_string: <access_token>` в
  shared-volume; Envoy перечитывает SDS `path_config_source` по move-событию —
  ротация без рестарта;
- спит `expires_in * 0.9`, при ошибке — retry с backoff; токены в лог не
  пишутся никогда.

Google-маршруты живут на **отдельном listener :8081** с собственным
`credential_injector` (SDS `google_token`): у `credential_injector` нет
per-route секретов, а смешивать LLM-ключ и Google-токен на одном listener
нельзя (LLM-ключ улетел бы в googleapis и наоборот).

## Alternatives considered

1. **oauth2-proxy / Envoy OAuth2-фильтр** — решают *downstream*-аутентификацию
   (логин пользователей в приложение), а не upstream-инжекцию: не наш случай.
2. **Готовый Gmail-MCP образ с собственной OAuth-логикой** — требует отдать
   credentials.json самому серверу в sandbox: нарушение V2 по построению.
3. **Refresh-логика в ядре** — LOC-бюджет 7500/7500 исчерпан (ADR-0009) и ядро
   увидело бы сырой токен: двойное нарушение.
4. **k8s-операторы ротации секретов** — не наш рантайм (docker-compose).

## Consequences

- **Плюс:** ~90 аудируемых строк вместо чужого supply chain; V2 сохраняется
  end-to-end (ядро/sandbox не видят токенов вообще, даже access).
- **Плюс:** параметризован env'ами (`OAUTH_TOKEN_URL`, `OAUTH_CREDS_FILE`,
  `OAUTH_SDS_OUT`) — пригоден для следующих OAuth-коннекторов (Microsoft, Notion).
- **Минус:** ещё один контейнер в compose; при его простое google-вызовы
  получают 401 (fail-closed — приемлемо).
- Первичный refresh-token владелец получает один раз вручную (OAuth consent —
  процедура в `connectors/google/SKILL.md`); автоматизация device flow — вне контура.
