---
name: caldav
description: CalDAV calendars and tasks (Nextcloud-compatible)
---

# CalDAV (C7)

Self-hosted calendars and tasks via CalDAV. Credentials live at the broker only.

## MCP tools

- `calendar_list` — list calendars
- `events_list` — list VEVENT items
- `tasks_list` — list VTODO items
- `task_create` — add task (reversible)
- `task_complete` — mark done (reversible)
- `task_delete` — delete task (irreversible → `/approve`)

## Setup

1. `aegis-setup connector add caldav`
2. Edit broker cluster_address to your Nextcloud host
3. Add `basic.txt` credentials at broker
