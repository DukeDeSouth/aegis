-- Sprint 16 / F6: метрики использования навыков.

CREATE TABLE IF NOT EXISTS skill_metrics (
  skill_name   TEXT    NOT NULL PRIMARY KEY,
  invocations  INTEGER NOT NULL DEFAULT 0,
  successes    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);
