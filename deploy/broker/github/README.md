# GitHub PAT (C5)

Fine-grained personal access token with repository permissions as needed.

```
deploy/broker/github/token.txt   # raw PAT, chmod 0600, not in git
deploy/broker/github/secret.yaml # SDS wrapper (committed)
```

Mount in `docker-compose.yml` for the broker service:

```yaml
volumes:
  - ./deploy/broker/github/secret.yaml:/etc/broker/github/secret.yaml:ro
  - ./deploy/broker/github/token.txt:/etc/broker/github/token.txt:ro
```
