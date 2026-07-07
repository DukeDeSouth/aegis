---
name: web-digest
description: Scheduled digest of configured HTTPS news sources
---

# Web Digest

Fetches configured sources and summarizes them through quarantine (untrusted web content).

## Commands

- `/digest` — fetch all sources below and produce a summary.

## Sources

Edit this list (owner): one HTTPS URL per line.

- https://example.com/news

## Scheduler

Add a cron entry in `aegis.config.json`, e.g. morning digest at 07:00 UTC:

```json
{ "id": "morning-digest", "cron": "07:00", "text": "/digest", "session_id": "tg:YOUR_CHAT_ID" }
```
