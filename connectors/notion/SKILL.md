---
name: notion
description: Notion pages and blocks via integration token
---

# Notion (C7)

Read and append Notion pages. Token stays at the broker.

## MCP tools

- `pages_search` — search workspace
- `page_get` — page metadata
- `blocks_list` — child blocks
- `page_append` — add paragraph (reversible)
- `page_archive` — archive page (irreversible → `/approve`)

## Setup

1. Create Notion integration, copy token to broker
2. `aegis-setup connector add notion`
3. Share pages with the integration in Notion UI
