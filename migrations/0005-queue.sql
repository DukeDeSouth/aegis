-- Sprint 13 / F3: one-shot напоминания (/remind).

CREATE TABLE IF NOT EXISTS reminders (
  id           TEXT    NOT NULL PRIMARY KEY,
  fire_at      INTEGER NOT NULL,
  text         TEXT    NOT NULL,
  session_id   TEXT    NOT NULL,
  fired        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (fire_at) WHERE fired = 0;
