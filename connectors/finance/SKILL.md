---
name: finance
description: Read-only expense journal from Gmail receipts
---

# Finance journal (C9)

Tracks spending from receipt-like emails. **Read-only** — no payments or transfers.

## Commands

- `/finance-ingest` — fetch recent receipts via Google MCP, append to `workspace/finance/`
- `/finance-report [YYYY-MM]` — monthly total from journal

## Journal

Files live in `workspace/finance/`:

- `YYYY-MM.jsonl` — one JSON object per detected expense
- `processed-ids.txt` — idempotent ingest

## Scheduler

```json
{ "id": "finance-ingest", "cron": "08:00", "text": "/finance-ingest", "session_id": "tg:YOUR_CHAT_ID" }
{ "id": "finance-report", "cron": "0 9 1 * *", "text": "/finance-report", "session_id": "tg:YOUR_CHAT_ID" }
```
