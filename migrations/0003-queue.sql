-- 0003-queue.sql — применяется к queue.db (docs/MEMORY_SCHEMA.md)
-- Human-gate: отложенные необратимые действия, ожидающие /approve от владельца.
-- Пишет orchestrator (create), adapter+orchestrator (consume). token — одноразовый.

CREATE TABLE pending_actions (
  token        TEXT PRIMARY KEY,
  action_id    TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  chat_id      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed     INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
);
CREATE INDEX idx_pending_expires ON pending_actions (consumed, expires_at);
