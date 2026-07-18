# ADR-0027: Sprint 39 S1 — remote credential broker

**Status:** Accepted (Sprint 39, 2026-07-17)  
**Date:** 2026-07-17  
**Context:** `cycle_sprint-39-s1-remote-_696203`

---

## Context

ADR-0004 planned broker on a separate host post-MVP. THREAT_MODEL V2 residual risk: broker and core on shared kernel — compromised core host can read `deploy/broker/token.txt`. Sprint 39 implements **S1**: physical split with mTLS.

## Decision

1. **Topology:** `deploy/broker-remote/` (secrets + Envoy mTLS :8443) on broker VPS; `deploy/broker-client/` (plain :8080 forwarder) on core host.
2. **Setup:** `aegis-setup init --broker-mode remote --broker-host <fqdn|ip>` generates CA/server/client certs; `web.broker_host` → `aegis-broker-client:8080`.
3. **Compose:** local broker unchanged (default); remote mode uses `COMPOSE_PROFILES=remote-broker` + broker-client only.
4. **Connectors:** routes written to `deploy/broker-remote/envoy.yaml` when `broker_mode=remote`.
5. **LOC ceiling:** **unchanged 11000** — all work outside `src/`.

## Consequences

**Positive:** V2 strengthened for advanced self-hosted; core FS has no API token files in remote mode.

**Negative:** Operational overhead (rsync envoy after connector add); client cert on core (authenticates to broker, does not grant secret files).

## Alternatives rejected

- WireGuard-only without mTLS — does not protect if WG keys on core are stolen.
- Core code changes for broker URL — unnecessary; config already parameterized.

---

**Accept after:** v2-remote test + aegis-setup tests green; DEPLOYMENT.md updated.
