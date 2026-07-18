# ADR-0018: WebChat delivery guarantees

**Status:** Accepted  
**Date:** 2026-07-16  
**Context:** Sprint 29 WebChat, cycles `webchat-ux-history`, `webchat-outbox-stale-waiter`

---

## Decision

WebChat использует **двухслойную доставку**:

1. **Live:** in-memory `WebchatOutbox` + long-poll `/api/poll` (best-effort, low latency).
2. **Durable:** `EpisodeStore` + `GET /api/history` (source of truth для UI reconcile).

UI **обязан** подтягивать хвост из history после send (tail-sync) и при load (hydrate). Poll alone — недостаточно.

Outbound queue: `ack` после `outbox.push`, не после client ACK. Потеря в RAM компенсируется episodes.

---

## Consequences

**Positive:** Минимальный fix без WebSocket; F5 и tail-sync гарантируют консистентность.

**Negative:** At-most-once в outbox при crash host между push и poll; episode tail — eventual consistency ~2–6s.

**Future:** episode id в outbound; persistent outbox — отдельный спринт.

**UI dedupe (2026-07-16):** `dedupe.js` — каждое сообщение по `id:{episodeId}` и `text:{role}:{content}`; tail-sync безопасен с poll/local send. M7: `webchat-post29-техдолг-dedupe-доставка/`.

---

## Related

- ADR-0014 (WebChat architecture)
- ADR-0017 (outbound channel routing)
