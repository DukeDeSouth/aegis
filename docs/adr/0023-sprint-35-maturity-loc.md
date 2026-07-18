# ADR-0023: Sprint 35 — maturity (L3 + S5) LOC

**Status:** Accepted (Sprint 35, 2026-07-17)  
**Date:** 2026-07-17  
**Context:** `cycle_sprint-35-l3-repeat-_309077`

---

## Context

Sprint 34 closed at **9764/9800 LOC** (ADR-0022). Sprint 35 adds:
- **L3** — chain repeat detector extension in `SkillProposalRunner`
- **S5** — minimal health HTTP server + orchestrator heartbeat

**S4** (`aegis-setup backup|restore`) lives entirely in `packages/aegis-setup` — outside core LOC.

## Decision

1. **LOC ceiling:** 9800 → **10100** (+300).
2. **L3:** extend `src/skills/proposal.ts` only; no new tables; chain signatures prefixed `chain:`.
3. **L3 config:** `learning.skill_chain_detection_enabled` (default `true`), `skill_chain_min_length` (2), `skill_chain_max_length` (3).
4. **S5:** `src/host/health.ts`; bind `127.0.0.1`; default port **8791**; config section `health`.
5. **S5 systemd:** update `deploy/systemd/aegis.service` with `WatchdogSec=60`, `Type=notify` when supported.
6. **S4:** tar.gz artifact with manifest; no core changes.

## Consequences

**Positive:** Operational maturity (backup/health); differentiated auto-composition from competitors; V4 preserved.

**Negative:** Core grows ~275 LOC; new localhost port to document; chain false positives possible (mitigated by threshold).

## Alternatives rejected

- Cloud backup — scope creep, V2 egress.
- Full Prometheus — over-engineering for single-tenant.
- LLM-only chain clustering — non-deterministic default.

---

**Accept after:** IMPLEMENTATION complete + tests green.
