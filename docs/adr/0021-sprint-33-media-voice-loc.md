# ADR-0021: Sprint 33 — media sandbox + voice STT LOC

**Status:** Accepted (Sprint 33)  
**Date:** 2026-07-16  
**Context:** `cycle_sprint-33-media-voice-c14-u1_948301`

---

## Context

Sprint 33 adds C14 (ffmpeg local transcode), U1 (Telegram voice → whisper STT), C16 (skill-only calendar). Ядро на **9400/9400** (ADR-0016).

Unlike Sprint 32 (0 LOC), U1 requires adapter + orchestrator hooks for voice download and quarantine STT.

## Decision

1. **LOC ceiling:** 9400 → **9800** (+400).
2. **Media sandbox image:** separate `AEGIS_MEDIA_SANDBOX_IMAGE` (ffmpeg + whisper.cpp, pinned digest); default alpine unchanged.
3. **C14:** `skills/media-pipeline/` scripts; `/media-transcode` in orchestrator (~80 LOC).
4. **U1 v1:** Telegram voice only; transcript **always** `provenance=quarantine`.
5. **C16:** `connectors/content-calendar/` — no core LOC.
6. **Matrix voice:** deferred.

## Consequences

**Positive:** Scenario #2 without cloud STT; local privacy; V3 network isolation for transcode.

**Negative:** Heavier sandbox image; core grows ~260 LOC; host CPU/RAM for ffmpeg.

## Alternatives rejected

- Cloud STT API — V2 egress + cost.
- Voice as plain owner_text without quarantine — V1 violation.
- Bundle ffmpeg into default alpine — breaks minimal web-fetch image size.

---

**Accept after:** IMPLEMENTATION complete + tests green.
