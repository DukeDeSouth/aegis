# Jellyfin API token (C17)

API key from Jellyfin **Dashboard → API Keys**.

```
deploy/broker/jellyfin/token.txt   # raw token, chmod 0600
deploy/broker/jellyfin/secret.yaml
```

Mount in `docker-compose.yml` for the broker service. Set `conn-medialibrary-*` cluster addresses to your Jellyfin host (default `127.0.0.1:8096`).
