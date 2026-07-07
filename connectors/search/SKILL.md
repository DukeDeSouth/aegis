---
name: search
description: Web search via self-hosted SearXNG (results pass quarantine)
---

# Search (C2)

`/research <query>` fetches SearXNG JSON results through the broker and summarizes
them via quarantine. Results are untrusted content: they can never trigger tool calls.

## Commands

- `/research <query>` — search and summarize top results.
- Follow-up: pick a result and `/fetch <https://url>` to read the page.

## Requirements

1. SearXNG container on the `aegis-egress` network (pinned image), e.g.:

```yaml
searxng:
  image: searxng/searxng:2025.6.30-8e9ae4b
  networks: [aegis-egress]
  environment:
    - SEARXNG_BASE_URL=http://searxng:8080/
```

2. Broker route `searxng.aegis` → `searxng:8080` (installed by `aegis-setup connector add search`).
3. `aegis.config.json`:

```json
{ "web": { "search_url": "https://searxng.aegis/search?q={query}&format=json" } }
```

The `https://` form is the core-side logical URL; the actual egress always goes
sandbox → broker (allowlisted Host), so no raw network reachability is added.
