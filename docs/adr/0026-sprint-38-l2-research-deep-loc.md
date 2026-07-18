# ADR-0026: Sprint 38 L2 — research-deep sub-agents LOC

**Status:** Accepted (Sprint 38, 2026-07-17)  
**Date:** 2026-07-17  
**Context:** `cycle_sprint-38-l2---resea_808090`

---

## Context

Sprint 37 closed at **10649/10700 LOC** (ADR-0025). Sprint 38 task L2 adds parallel research via `/research-deep`: Q-LLM decompose, N fetch+Q branches, P-LLM synthesis.

## Decision

1. **LOC ceiling:** 10700 → **11000** (+300).
2. **L2:** `ResearchDeepRunner` in `src/host/research/deep.ts`; branches Q-only (no tools); UNTRUSTED synthesis.
3. **Config:** `research_deep_enabled` default `false`; `research_deep_branch_count` default 3; `research_deep_token_cap` default 12000.
4. **Invariant:** sub-agents cannot invoke tools — quarantine reader only.

## Consequences

**Positive:** Hermes-style parallel research without shell agents; reuses fetch+quarantine stack.

**Negative:** +~280 LOC core; higher token burn per command (mitigated by cap + default off).

## Alternatives rejected

- Queue-based sub-agent workers — complexity, no safety win.
- P-LLM with tools per branch — tool surface risk.

---

**Accept after:** IMPLEMENTATION L2 complete + tests green.
