-- 0008-queue.sql — F10: ключи channel_state для Discord и email
CREATE TABLE channel_state_new (
  key TEXT PRIMARY KEY CHECK (
    key IN (
      'owner_user_id',
      'updates_offset',
      'discord_owner_user_id',
      'discord_last_sequence',
      'email_last_uid'
    )
  ),
  value TEXT NOT NULL
);
INSERT INTO channel_state_new SELECT * FROM channel_state;
DROP TABLE channel_state;
ALTER TABLE channel_state_new RENAME TO channel_state;
