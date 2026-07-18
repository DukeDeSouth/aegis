# Remote credential broker (Sprint 39 S1)

Выделенный хост для Envoy + секретов. Ядро на другой машине; канал — **mTLS** через `deploy/broker-client/` на core-хосте.

## Layout

```
broker-remote/
  envoy.yaml          # mTLS :8443 + credential_injector
  secret.yaml         # SDS → token.txt
  secrets/token.txt   # API keys (mode 600, not in git)
  certs/server/       # server.crt, server.key, ca.crt
  docker-compose.yml
```

## Bootstrap

1. На core-хосте: `aegis-setup init --broker-mode remote --broker-host <fqdn|ip>`
2. Скопируйте `deploy/broker-remote/` на broker VPS (`scp` / `rsync`)
3. На broker VPS: положите `secrets/token.txt`, при необходимости OAuth/IMAP sidecars
4. `docker compose up -d`
5. Firewall: TCP **8443** только с IP core-хоста

## Connectors

`aegis-setup connector add` в remote-режиме пишет маршруты в **этот** `envoy.yaml`. После добавления — rsync и `docker compose restart broker`.

## Smoke (on broker host, with client cert)

```bash
curl --cacert certs/server/ca.crt --cert ../broker-client/certs/client/client.crt \
  --key ../broker-client/certs/client/client.key \
  -H 'Host: evil.not-in-allowlist.test' https://127.0.0.1:8443/ -k -o /dev/null -w '%{http_code}\n'
# expect 404
```

См. также [`../broker/README.md`](../broker/README.md) и [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md).
