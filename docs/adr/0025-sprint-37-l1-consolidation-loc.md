# ADR-0025: Sprint 37 L1 — LLM memory consolidation LOC

**Status:** Accepted (Sprint 37, 2026-07-17)  
**Date:** 2026-07-17  
**Context:** `cycle_sprint-37-l1-llm--q-_317568`

---

## Context

Sprint 36 closed at **10366/10400 LOC** (ADR-0024). Sprint 37 task L1 adds Q-LLM semantic merge of corroborated facts via `/consolidate`, with deterministic apply through `PromotionGate`.

## Decision

1. **LOC ceiling:** 10400 → **10700** (+300).
2. **L1:** `ConsolidationRunner` + strict JSON protocol; new facts `unverified` with provenance `consolidation`; gate `llm_consolidate`; evidence `llm_proposal`.
3. **Config:** `learning.memory_consolidation_enabled` default `false`; `consolidation_batch_size` default 25.
4. **Invariant:** Q-LLM proposes only; V4 (poisoning) unchanged — consolidation output never auto-promotes.

## Consequences

**Positive:** Semantic dedup complements deterministic `/curate`; snapshot before mutate.

**Negative:** +~210 LOC core; migration 0014 rebuilds memory CHECK constraints.

## Alternatives rejected

- Reuse `/curate` — mixes free deterministic phase with paid LLM phase.
- Auto-promote consolidated facts — breaks V4 trust model.

---

**Accept after:** IMPLEMENTATION L1 complete + tests green.
