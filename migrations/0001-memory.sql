-- 0001-memory.sql — применяется к memory.db (docs/MEMORY_SCHEMA.md)

-- Эпизодическая память
CREATE TABLE episodes (
  id         INTEGER PRIMARY KEY,
  session_id TEXT    NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('owner','assistant','tool','quarantine')),
  content    TEXT    NOT NULL,
  provenance TEXT    NOT NULL CHECK (provenance IN ('owner','orchestrator','quarantine','background')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_episodes_session ON episodes (session_id, created_at);

-- Полнотекстовый поиск без LLM (bm25), external-content: без дублирования текста
CREATE VIRTUAL TABLE episodes_fts USING fts5(
  content, content='episodes', content_rowid='id'
);
CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- Семантическая память (знания и навыки)
CREATE TABLE knowledge (
  id               INTEGER PRIMARY KEY,
  kind             TEXT    NOT NULL CHECK (kind IN ('fact','procedure','skill')),
  title            TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  epistemic_status TEXT    NOT NULL DEFAULT 'unverified'
                   CHECK (epistemic_status IN ('unverified','corroborated','verified','refuted')),
  provenance       TEXT    NOT NULL CHECK (provenance IN ('owner','orchestrator','quarantine','background')),
  skill_ref        TEXT,             -- kind='skill': git-url#pinned-commit
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_used_at     INTEGER,
  use_count        INTEGER NOT NULL DEFAULT 0,   -- метрика reuse_rate
  stale_after      INTEGER,                      -- staleness-курация
  CHECK (kind != 'skill' OR skill_ref IS NOT NULL)
);
CREATE INDEX idx_knowledge_status ON knowledge (epistemic_status, kind);

-- Evidence — отдельная таблица (FK-целостность, счётчики, типизация)
CREATE TABLE evidence (
  id            INTEGER PRIMARY KEY,
  knowledge_id  INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  evidence_type TEXT    NOT NULL CHECK (evidence_type IN
                ('test_pass','reproduced_observation','owner_confirmation','external_source')),
  summary       TEXT    NOT NULL CHECK (length(summary) <= 2000),  -- защита от раздувания
  ref           TEXT,   -- ссылка: episode:id / audit:id / url
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_evidence_knowledge ON evidence (knowledge_id);
-- Лимит evidence на знание (например, 20) enforce'ится ядром при вставке;
-- превышение — сигнал курации, не повод писать ещё.

-- Переходы статусов — журнал + инварианты триггерами
CREATE TABLE status_transitions (
  id           INTEGER PRIMARY KEY,
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  from_status  TEXT    NOT NULL,
  to_status    TEXT    NOT NULL,
  gate         TEXT    NOT NULL CHECK (gate IN ('auto_corroborate','owner_verify','refutation','decay')),
  evidence_id  INTEGER REFERENCES evidence(id),
  created_at   INTEGER NOT NULL
);

-- Инвариант V4: недоверенный provenance рождается только unverified
CREATE TRIGGER knowledge_no_selfpromote
BEFORE INSERT ON knowledge
WHEN NEW.provenance IN ('quarantine','background') AND NEW.epistemic_status != 'unverified'
BEGIN SELECT RAISE(ABORT, 'untrusted provenance must start unverified'); END;

-- Promotion в corroborated требует детерминированного evidence
CREATE TRIGGER knowledge_corroborate_needs_evidence
BEFORE UPDATE OF epistemic_status ON knowledge
WHEN NEW.epistemic_status = 'corroborated'
     AND NOT EXISTS (SELECT 1 FROM evidence
                     WHERE knowledge_id = NEW.id
                       AND evidence_type IN ('test_pass','reproduced_observation'))
BEGIN SELECT RAISE(ABORT, 'corroborated requires deterministic evidence'); END;

-- Verified требует подтверждения владельца или независимого источника
CREATE TRIGGER knowledge_verify_needs_confirmation
BEFORE UPDATE OF epistemic_status ON knowledge
WHEN NEW.epistemic_status = 'verified'
     AND NOT EXISTS (SELECT 1 FROM evidence
                     WHERE knowledge_id = NEW.id
                       AND evidence_type IN ('owner_confirmation','external_source'))
BEGIN SELECT RAISE(ABORT, 'verified requires owner confirmation or independent source'); END;

-- Снапшоты (метаданные файлов VACUUM INTO)
CREATE TABLE snapshots (
  id         INTEGER PRIMARY KEY,
  path       TEXT    NOT NULL,   -- файл, созданный VACUUM INTO
  reason     TEXT    NOT NULL,   -- 'pre-curation' | 'pre-consolidation' | 'manual'
  created_at INTEGER NOT NULL
);
