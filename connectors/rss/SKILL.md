---
name: rss
description: RSS/Atom feed digests through the existing /digest pipeline
---

# RSS (C6)

Feeds are ordinary digest sources: `/digest` fetches every URL below through the
sandbox fetcher, which detects RSS/Atom XML and distills item titles and links
before anything reaches quarantine.

## Commands

- `/digest` — fetch all sources (this skill and `web-digest`) and summarize.
- `/fetch <https://feed-url>` — one-off digest of a single feed.

## Sources

Edit this list (owner): one HTTPS feed URL per line.

- https://hnrss.org/frontpage

## Adding a feed

1. Add the URL above.
2. Ensure the feed host has a broker route (fail-closed: unknown Host → 404).
   `aegis-setup connector add rss` installs routes listed in the preset.

## Scheduler

Cron entry is printed by `aegis-setup connector add rss`.
