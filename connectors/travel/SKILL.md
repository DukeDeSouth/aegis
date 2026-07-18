---
name: travel
description: Read-only travel briefing from Gmail + flight status API
---

# Travel briefing (C20)

Aggregates hotel/flight confirmations from email and optional live flight status. **Read-only** — no bookings or payments.

## Commands

- `/travel-ingest` — fetch travel-related Gmail via Google MCP → `workspace/travel/bookings.jsonl`
- `/travel-brief [FLIGHT]` — build `workspace/travel/brief.md`; optional `FLIGHT` (e.g. `SU123`) refreshes aviationstack cache first

## Workspace layout

- `bookings.jsonl` — parsed confirmations (idempotent via `processed-ids.txt`)
- `flight-<IATA>.json` — cached aviationstack response
- `brief.md` — human-readable summary for owner

## Flight API (aviationstack)

1. Register at [aviationstack](https://aviationstack.com/) and store the access key at `deploy/broker/travel/api-key.txt`.
2. Run the travel-proxy sidecar (`deploy/broker/travel/README.md`) on the broker host.
3. `aegis-setup connector add travel` — listener `:8087` injects the key; sandbox calls `travel.local` only (key never in workspace).

## Scheduler

```json
{ "id": "travel-ingest", "cron": "08:30", "text": "/travel-ingest", "session_id": "tg:YOUR_CHAT_ID" }
{ "id": "travel-brief", "cron": "18:00", "text": "/travel-brief", "session_id": "tg:YOUR_CHAT_ID" }
```

Customize the brief cron to the day before departure.
