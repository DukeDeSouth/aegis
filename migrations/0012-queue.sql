-- 0012-queue.sql — Sprint 31: Slack channel_state key
CREATE TABLE channel_state_new (
  key TEXT PRIMARY KEY CHECK (
    key IN (
      'owner_user_id',
      'updates_offset',
      'discord_owner_user_id',
      'discord_last_sequence',
      'email_last_uid',
      'webchat_paired',
      'webchat_session_token',
      'matrix_owner_user_id',
      'matrix_sync_token',
      'slack_owner_user_id'
    )
  ),
  value TEXT NOT NULL
);
INSERT INTO channel_state_new SELECT * FROM channel_state;
DROP TABLE channel_state;
ALTER TABLE channel_state_new RENAME TO channel_state;
