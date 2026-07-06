-- 0001-audit.sql — применяется к audit.db (docs/MEMORY_SCHEMA.md)
-- Tamper-evident журнал: hash chain + append-only.

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  actor        TEXT    NOT NULL,   -- 'orchestrator' | 'gate' | 'scheduler' | 'curation' | ...
  action       TEXT    NOT NULL,
  action_class TEXT    CHECK (action_class IN ('read-only','reversible','irreversible')),
  decision     TEXT    NOT NULL CHECK (decision IN ('allow','deny','confirm_required','info')),
  payload_hash TEXT    NOT NULL,   -- sha256 полезной нагрузки
  prev_hash    TEXT    NOT NULL,   -- entry_hash предыдущей записи (hash chain)
  entry_hash   TEXT    NOT NULL    -- sha256(ts||actor||action||decision||payload_hash||prev_hash)
);

-- Append-only: любые UPDATE/DELETE запрещены
CREATE TRIGGER audit_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TRIGGER audit_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
