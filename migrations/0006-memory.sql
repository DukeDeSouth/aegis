-- Sprint 15 / F5: draft-навыки из эпизодов.

CREATE TABLE IF NOT EXISTS skill_proposal_suppressions (
  signature    TEXT    NOT NULL PRIMARY KEY,
  suppressed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_proposals (
  signature          TEXT    NOT NULL PRIMARY KEY,
  skill_name         TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
  sample_session_ids TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
