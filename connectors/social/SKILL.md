---
name: social
description: Social publishing via Postiz (multi-platform)
---

# Social publishing (C13)

Schedule and publish posts through **self-hosted Postiz**. Platform OAuth lives in Postiz UI; AEGIS holds only the Postiz API key at the broker.

## MCP tools

- `integrations_list` — connected channels (read-only)
- `analytics_summary` — metrics for integration (read-only)
- `post_draft` — save draft (reversible)
- `post_schedule` — schedule post (reversible)
- `post_publish` — publish now (**irreversible** → `/approve`)
- `post_delete` — delete post (**irreversible** → `/approve`)

Autonomous DM/outreach is **not** mapped.

## Workflow

1. Owner: «Напиши пост про X для LinkedIn»
2. Agent: `post_draft` or `post_schedule`
3. Owner reviews in chat or Postiz UI
4. To publish: `/approve <pending-id>` when agent requests `post_publish`

## Setup

1. Deploy [Postiz](https://docs.postiz.com/installation/docker-compose) on your infra
2. Settings → Developers → Public API key → `deploy/broker/social/api-key.txt`
3. `aegis-setup connector add social`
4. Connect X/LinkedIn/etc. inside Postiz

## Example

```
/mcp social integrations_list {}
/mcp social post_schedule {"integration_id":"...","content":"Hello","platform":"x","date":"2026-07-17T09:00:00.000Z"}
```
