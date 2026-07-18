# ADR-0022: Sprint 34 — self-hosted быт, 0 core LOC

**Status:** Accepted (Sprint 34, 2026-07-17)  
**Date:** 2026-07-17  
**Context:** `cycle_sprint-34-self-hoste_782214`

---

## Decision

1. **LOC ceiling:** **9800 unchanged** (ADR-0021).
2. **C17:** single `connectors/medialibrary` with 3 broker listeners (:8087–8089).
3. **C18:** `connectors/bookmarks` → linkding primary.
4. **C19:** skill-only `connectors/shopping-list`.
5. **U3/U4:** changes only in `packages/aegis-webchat` and `packages/aegis-dashboard`.

## Consequences

**Positive:** Homelab scenarios without core growth; observability for connector park.

**Negative:** 4 new broker listeners to maintain; user must run *arr/Jellyfin stacks.

---

**Accept after:** IMPLEMENTATION complete + tests green.
