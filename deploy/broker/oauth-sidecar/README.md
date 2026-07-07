# oauth-sidecar (ADR-0010)

Мини-процесс в trust-домене broker: держит refresh-token, обновляет access-token
и отдаёт его Envoy через SDS-файл. Ядро и sandbox токенов не видят (V2).

## Как это работает

```
google-oauth.json (только sidecar, 0600)          google-secret.yaml (shared volume)
{client_id, client_secret, refresh_token}  ──►  resources: [{name: google_token,
POST oauth2.googleapis.com/token                  generic_secret: {inline_string: <access>}}]
                                                  ▲ Envoy SDS перечитывает по rename
```

- Запись атомарная (`.tmp` + rename) — Envoy подхватывает без рестарта.
- Ошибка refresh → retry через 30 с; до первого успеха google-запросы через
  broker получают 401 (fail-closed, `allow_request_without_credential: false`).
- Токены никогда не пишутся в лог (только статус и `expires_in`).

## Получение refresh-token (один раз, вручную)

1. Google Cloud Console → создать OAuth client (Desktop app), включить Gmail API
   и Calendar API.
2. Пройти consent-флоу со scope'ами
   `https://www.googleapis.com/auth/gmail.modify` и
   `https://www.googleapis.com/auth/calendar` (например, через
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) с
   собственным client id/secret) и забрать refresh-token.
3. Положить `deploy/broker/google-oauth.json` (вне git, mode 600):

```json
{ "client_id": "…", "client_secret": "…", "refresh_token": "…" }
```

## Compose

Раскомментируйте сервис `oauth-sidecar` в `deploy/docker-compose.yml` (образец
там же). Broker монтирует `./broker/oauth` **ro**, sidecar — **rw**; сырой
`google-oauth.json` монтируется только sidecar'у.

**Порядок старта:** Envoy требует существования SDS-файла на старте
(`path_config_source`, проверено `envoy --mode validate`). Запустите sidecar до
broker (`docker compose up -d oauth-sidecar && sleep 2 && docker compose up -d broker`)
или создайте placeholder — до первого refresh запросы честно получат 401:

```sh
OAUTH_ONE_SHOT=1 OAUTH_CREDS_FILE=deploy/broker/google-oauth.json \
  OAUTH_SDS_OUT=deploy/broker/oauth/google-secret.yaml node deploy/broker/oauth-sidecar/sidecar.mjs
```

## Проверка

```sh
docker compose logs oauth-sidecar   # "refreshed google_token, expires_in=3599s"
OAUTH_ONE_SHOT=1 OAUTH_CREDS_FILE=… OAUTH_SDS_OUT=/tmp/out.yaml node sidecar.mjs
```
