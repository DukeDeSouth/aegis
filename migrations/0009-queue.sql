-- 0009-queue.sql — Sprint 27: out-of-band 2FA metadata for pending_actions
ALTER TABLE pending_actions ADD COLUMN origin_session_id TEXT;
ALTER TABLE pending_actions ADD COLUMN required_channel TEXT;
UPDATE pending_actions
  SET origin_session_id = 'tg:' || chat_id
  WHERE origin_session_id IS NULL;
