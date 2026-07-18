# ADR-0020: Sprint 32 — C13 Social publishing via Postiz

**Status:** Accepted  
**Date:** 2026-07-16  
**Context:** `cycle_sprint-32-social-c13-c15_935201` — **implemented Sprint 32**

---

## Context

Sprint 32 закрывает social publishing (BACKLOG C13). Варианты: self-hosted Postiz vs прямой X API.

## Decision

**Primary connector: `connectors/social` → Postiz Public API** через dedicated broker listener (:8086) с static API key в SDS.

- Platform OAuth (X, LinkedIn, …) настраивается **в Postiz UI**, не в AEGIS.
- AEGIS хранит только **Postiz API key** у broker (V2).
- `post_publish`, `post_delete` — **irreversible** → `/approve`.
- Autonomous DM/outreach — **не маппится**.

Direct X API (`connectors/x`) — **deferred**; не блокирует Sprint 32 DoD.

## C15

Inbox-триаж — **skill-only** композиция C1 (`connectors/inbox-triage`), без кода ядра.

## Consequences

**Positive:** Multi-platform с одним секретом; официальные OAuth флоу платформ в Postiz; сценарий №1 рынка.

**Negative:** Postiz stack (Postgres, Redis, Temporal) — отдельный deploy; AGPL-3 — отдельный сервис; trust-домен Postiz.

## Alternatives rejected

- Direct X only — не покрывает LinkedIn/IG/TikTok.
- Composio/managed OAuth — V2 violation.
- Core orchestrator `/social` rewrite — unnecessary vs `/mcp social`.

---

**Accept after:** IMPLEMENTATION complete + tests green.
