# IMAP bridge (Sprint 26)

HTTP sidecar в trust-домене broker. Учётные данные IMAP остаются здесь; ядро опрашивает `GET /messages?since_uid=N` через `BrokerHttpEmailFetcher`.

## Bootstrap

1. Скопируйте `imap-creds.example.json` → `imap-creds.json` (не коммитьте).
2. Добавьте сервис в `deploy/docker-compose.yml` (сеть `aegis-internal`, без egress наружу с host):

```yaml
  imap-bridge:
    image: node:24-alpine
    restart: unless-stopped
    command: ['node', '/app/bridge.mjs']
    networks: [aegis-internal]
    environment:
      IMAP_CREDS_FILE: /etc/imap/creds.json
      IMAP_BRIDGE_PORT: '8090'
    volumes:
      - ./broker/imap-bridge/bridge.mjs:/app/bridge.mjs:ro
      - ./broker/imap-creds.json:/etc/imap/creds.json:ro
```

3. В `aegis.config.json`:

```json
"email": {
  "poll_interval_s": 60,
  "session_id": "email:inbox",
  "imap_bridge_host": "http://imap-bridge:8090"
}
```

4. `docker compose up -d imap-bridge` и перезапустите host.

## API

- `GET /health` → `{"ok":true}`
- `GET /messages?since_uid=0` → `[{ "uid", "from", "subject", "body" }, …]`
