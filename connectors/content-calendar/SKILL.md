---
name: content-calendar
description: Weekly content plan draft (C13 + research composition)
---

# Content calendar (C16)

Cron-driven **weekly content plan** using social analytics and web research. No new core code.

## Prerequisites

- `aegis-setup connector add social` (C13 post analytics)
- SearXNG / search connector for `/research`

## Procedure (weekly)

1. `/mcp social post_analytics {"period":"7d"}` — top posts by engagement
2. `/research <niche> trends this week` — external signals
3. `/write workspace/content/calendar-YYYY-Www.md` — Mon–Sun slots with draft topics
4. Optional: link to `/media-transcode` outputs in `workspace/media/out/`

## Scheduler

```json
{
  "id": "content-calendar",
  "cron": "Mon 09:00",
  "text": "Draft weekly content calendar: analytics + research → workspace/content/calendar.md",
  "session_id": "webchat:local"
}
```

## Output layout

```
workspace/content/
  calendar-2026-W28.md   # weekly plan
```
