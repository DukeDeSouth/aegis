---
name: watch
description: Monitor pages and prices for changes via /watch
---

# Price / page watch (C8)

Tracks HTTPS pages you care about. The first `/watch` stores a baseline in
`workspace/watch/`; later runs compare and notify only when text or a detected
price changes.

## Commands

- `/watch <https://url>` — fetch, diff, notify on change (scheduler-friendly)

## URLs to monitor

Edit (owner): one HTTPS URL per line.

- https://example.com/product/123

## Broker routes

Each watched host needs a broker route (unknown Host → 404). Add routes manually
to `deploy/broker/envoy.yaml` or use a connector that already allows the host.

## Scheduler

`aegis-setup connector add watch` prints a cron hint. Example every 30 minutes:

```json
{ "id": "price-watch", "cron": "*/30", "text": "/watch https://example.com/product/123", "session_id": "tg:YOUR_CHAT_ID" }
```
