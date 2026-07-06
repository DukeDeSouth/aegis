-- 0001-queue.sql — применяется к queue.db (docs/MEMORY_SCHEMA.md)
-- Модель SQS: статус выражен временем видимости, claim атомарен.

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY,
  queue        TEXT    NOT NULL CHECK (queue IN ('inbound','outbound')),
  payload      TEXT    NOT NULL,              -- JSON
  provenance   TEXT    NOT NULL CHECK (provenance IN ('owner','quarantine','scheduler','system')),
  created_at   INTEGER NOT NULL,
  visible_at   INTEGER NOT NULL,              -- <= now → доступно; > now → claimed/отложено
  claimed_by   TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  dead         INTEGER NOT NULL DEFAULT 0     -- dead letter: attempts исчерпаны
);
CREATE INDEX idx_messages_poll ON messages (queue, dead, visible_at);
