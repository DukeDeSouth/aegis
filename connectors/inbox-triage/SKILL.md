---
name: inbox-triage
description: Morning inbox triage via Gmail (C1 composition)
---

# Inbox triage (C15)

Cron-driven **inbox zero** workflow using existing Google connector. No new core code.

## Prerequisites

- `aegis-setup connector add google` + OAuth sidecar
- Gmail scopes for search + draft

## Procedure (morning)

1. `/mcp google gmail_search {"query":"is:unread newer_than:1d"}`
2. Categorize: **urgent** / **action** / **fyi**
3. `/write workspace/inbox/today.md` — summary with categories
4. For **urgent** only: `/mcp google gmail_draft` with reply text
5. **Never** `gmail_send` without explicit `/approve`

## Scheduler

```json
{
  "id": "inbox-morning",
  "cron": "08:00",
  "text": "Inbox triage: search unread last 24h, categorize, write workspace/inbox/today.md, draft replies for urgent — do not send",
  "session_id": "webchat:local"
}
```

## Output layout

```
workspace/inbox/
  today.md          # daily summary
  YYYY-MM-DD.jsonl  # optional structured log
```
