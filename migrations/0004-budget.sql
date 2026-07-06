-- Sprint 9: дневной бюджет LLM + идемпотентность scheduler.

CREATE TABLE IF NOT EXISTS budget_daily (
  day            TEXT    NOT NULL PRIMARY KEY,
  tokens_used    INTEGER NOT NULL DEFAULT 0,
  limit_tokens   INTEGER NOT NULL,
  exhausted_at   INTEGER
);

CREATE TABLE IF NOT EXISTS scheduler_fired (
  schedule_id    TEXT    NOT NULL,
  fire_key       TEXT    NOT NULL,
  fired_at       INTEGER NOT NULL,
  PRIMARY KEY (schedule_id, fire_key)
);
