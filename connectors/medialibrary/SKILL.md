---
name: medialibrary
description: Jellyfin, Radarr, Sonarr homelab queries (C17)
---

# Media library (C17)

Self-hosted **Jellyfin + *arr** stack via broker listeners :8087–8089.

## Prerequisites

```bash
aegis-setup connector add medialibrary
```

Configure API keys in `deploy/broker/{jellyfin,radarr,sonarr}/` and cluster addresses in envoy.

## Examples

- «Что качается?» → `/mcp medialibrary radarr_queue_list {}`
- «Найди фильм Inception» → `/mcp medialibrary radarr_movie_search {"term":"Inception"}`
- «Добавь сериал» → `/mcp medialibrary sonarr_series_add` (reversible)
- Delete / remove → **irreversible** → `/approve`

## Safety

- Read-only: search, queue, sessions
- Add to library: reversible
- Delete: irreversible — never without owner `/approve`
