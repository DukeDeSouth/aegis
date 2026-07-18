---
name: bookmarks
description: Save and review links via linkding (C18)
---

# Bookmarks (C18)

**linkding** read-later via broker :8090.

## Examples

- «Сохрани ссылку» → `/mcp bookmarks bookmark_save {"url":"https://…","title":"…"}`
- «Что не прочитал?» → `/mcp bookmarks bookmark_list {"unread":true}`
- Weekly digest → cron in `connector.json` hints

## Safety

- `bookmark_delete` — irreversible → `/approve`
