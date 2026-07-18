-- Sprint 37 / L1: consolidation provenance, llm_proposal evidence, llm_consolidate gate.

CREATE TABLE knowledge_new (
  id               INTEGER PRIMARY KEY,
  kind             TEXT    NOT NULL CHECK (kind IN ('fact','procedure','skill')),
  title            TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  epistemic_status TEXT    NOT NULL DEFAULT 'unverified'
                   CHECK (epistemic_status IN ('unverified','corroborated','verified','refuted')),
  provenance       TEXT    NOT NULL CHECK (provenance IN ('owner','orchestrator','quarantine','background','consolidation')),
  skill_ref        TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_used_at     INTEGER,
  use_count        INTEGER NOT NULL DEFAULT 0,
  stale_after      INTEGER,
  CHECK (kind != 'skill' OR skill_ref IS NOT NULL)
);
INSERT INTO knowledge_new SELECT * FROM knowledge;

CREATE TABLE evidence_new (
  id            INTEGER PRIMARY KEY,
  knowledge_id  INTEGER NOT NULL REFERENCES knowledge_new(id) ON DELETE CASCADE,
  evidence_type TEXT    NOT NULL CHECK (evidence_type IN
                ('test_pass','reproduced_observation','owner_confirmation','external_source','llm_proposal')),
  summary       TEXT    NOT NULL CHECK (length(summary) <= 2000),
  ref           TEXT,
  created_at    INTEGER NOT NULL
);
INSERT INTO evidence_new SELECT * FROM evidence;

CREATE TABLE status_transitions_new (
  id           INTEGER PRIMARY KEY,
  knowledge_id INTEGER NOT NULL REFERENCES knowledge_new(id) ON DELETE CASCADE,
  from_status  TEXT    NOT NULL,
  to_status    TEXT    NOT NULL,
  gate         TEXT    NOT NULL CHECK (gate IN ('auto_corroborate','owner_verify','refutation','decay','llm_consolidate')),
  evidence_id  INTEGER REFERENCES evidence_new(id),
  created_at   INTEGER NOT NULL
);
INSERT INTO status_transitions_new SELECT * FROM status_transitions;

DROP TABLE status_transitions;
DROP TABLE evidence;
DROP TABLE knowledge;

ALTER TABLE knowledge_new RENAME TO knowledge;
ALTER TABLE evidence_new RENAME TO evidence;
ALTER TABLE status_transitions_new RENAME TO status_transitions;

CREATE INDEX idx_knowledge_status ON knowledge (epistemic_status, kind);
CREATE INDEX idx_evidence_knowledge ON evidence (knowledge_id);

CREATE TRIGGER knowledge_no_selfpromote
BEFORE INSERT ON knowledge
WHEN NEW.provenance IN ('quarantine','background','consolidation') AND NEW.epistemic_status != 'unverified'
BEGIN SELECT RAISE(ABORT, 'untrusted provenance must start unverified'); END;

CREATE TRIGGER knowledge_corroborate_needs_evidence
BEFORE UPDATE OF epistemic_status ON knowledge
WHEN NEW.epistemic_status = 'corroborated'
     AND NOT EXISTS (SELECT 1 FROM evidence
                     WHERE knowledge_id = NEW.id
                       AND evidence_type IN ('test_pass','reproduced_observation'))
BEGIN SELECT RAISE(ABORT, 'corroborated requires deterministic evidence'); END;

CREATE TRIGGER knowledge_verify_needs_confirmation
BEFORE UPDATE OF epistemic_status ON knowledge
WHEN NEW.epistemic_status = 'verified'
     AND NOT EXISTS (SELECT 1 FROM evidence
                     WHERE knowledge_id = NEW.id
                       AND evidence_type IN ('owner_confirmation','external_source'))
BEGIN SELECT RAISE(ABORT, 'verified requires owner confirmation or independent source'); END;
