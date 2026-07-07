-- 0002-memory.sql — web fetch cache (Sprint 12 / F2)

CREATE TABLE web_cache (
  url_hash   TEXT    PRIMARY KEY,
  url        TEXT    NOT NULL,
  digest     TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX idx_web_cache_fetched ON web_cache (fetched_at);
