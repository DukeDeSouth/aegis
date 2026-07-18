# ADR-0024: Sprint 36 U2 — TTS voice replies LOC

**Status:** Accepted (Sprint 36, 2026-07-17)  
**Date:** 2026-07-17  
**Context:** `cycle_sprint-36-u2-tts-_847201`

---

## Context

Sprint 35 closed at **9994/10100 LOC** (ADR-0023). Sprint 36 task U2 adds TTS outbound path: synthesizer, outbound schema, loop hook, Telegram `sendVoice`.

## Decision

1. **LOC ceiling:** 10100 → **10400** (+300).
2. **U2:** `SandboxVoiceSynthesizer` + `voice-synthesize.sh` in media sandbox; outbound `voice_rel_path`; Telegram v1 only.
3. **TTS engine:** espeak-ng in `Dockerfile.media` default; piper optional via mount.
4. **Triggers:** `/voice-reply on|off` per-session; phrase «ответь голосом»; no auto voice-out after inbound voice (v1).

## Consequences

**Positive:** Completes voice loop after U1; V3 network-none preserved.

**Negative:** +~230 LOC core; heavier media image.

## Alternatives rejected

- Cloud TTS — V2 egress.
- TTS in adapter — breaks sandbox trust boundary.

---

**Accept after:** IMPLEMENTATION U2 complete + tests green.
