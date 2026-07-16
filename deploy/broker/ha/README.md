# Home Assistant token (C4)

Long-lived token from HA **Profile → Security → Long-Lived Access Tokens**.

```
deploy/broker/ha/token.txt   # raw token, chmod 0600, not in git
deploy/broker/ha/secret.yaml # SDS wrapper (committed)
```

Mount in `docker-compose.yml` for the broker service:

```yaml
volumes:
  - ./deploy/broker/ha/secret.yaml:/etc/broker/ha/secret.yaml:ro
  - ./deploy/broker/ha/token.txt:/etc/broker/ha/token.txt:ro
```

After `aegis-setup connector add homeassistant`, set `conn-homeassistant-0`
cluster address to your HA host (LAN IP or `host.docker.internal`).
