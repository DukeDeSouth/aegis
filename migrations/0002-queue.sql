-- 0002-queue.sql — применяется к queue.db (docs/MEMORY_SCHEMA.md)
-- Состояние Telegram-канала: pairing владельца и offset getUpdates.
-- Пишет только adapter. CHECK на key — закрытый список, расширение только миграцией.

CREATE TABLE channel_state (
  key   TEXT PRIMARY KEY CHECK (key IN ('owner_user_id','updates_offset')),
  value TEXT NOT NULL
);
