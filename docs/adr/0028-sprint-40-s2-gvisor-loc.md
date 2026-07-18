# ADR-0028: Sprint 40 S2 — gVisor sandbox runtime LOC

**Status:** Accepted (Sprint 40, 2026-07-17)  
**Date:** 2026-07-17  
**Context:** `cycle_sprint-40-s2-gvisor-_785838`

---

## Context

ADR-0006 defines upgrade-path: gVisor (`runsc`) first, then micro-VM. Sprint 39 closed at **10973/11000 LOC** (ADR-0026/0027). Sprint 40 S2 adds opt-in `sandbox.runtime: gvisor` without new runner class.

## Decision

1. **Config:** `sandbox.runtime: docker | gvisor` (default `docker`).
2. **Mechanism:** `DockerSandboxRunner` passes `--runtime runsc` when `gvisor`; hardened profile unchanged.
3. **Deploy:** `deploy/gvisor/` — install README + `daemon.json.example`.
4. **Verify:** `aegis-setup verify` smoke runsc when `runtime=gvisor`.
5. **LOC ceiling:** 11000 → **11200** (+200).

## Consequences

**Positive:** V3 residual risk reduced on Linux prod without breaking macOS dev default.

**Negative:** gVisor Linux-only; operational step to install runsc; syscall compatibility edge cases.

## Alternatives rejected

- New `GvisorSandboxRunner` class — duplicate hardened flags.
- Firecracker in Sprint 40 — KVM/host complexity; deferred Sprint 41+.

---

**Accept after:** v3-gvisor + unit tests green; DEPLOYMENT.md updated.
