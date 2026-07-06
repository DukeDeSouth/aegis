# Схема данных: память, очереди, аудит

Прототип схемы для Sprint 0 (задача Фазы 0 из [`../ROADMAP.md`](../ROADMAP.md)). Реализует модель [`LEARNING_LOOP.md`](LEARNING_LOOP.md). Фиксируется миграцией `0001` в Sprint 1; до Sprint 5 (реализация памяти) правки дёшевы.

## Принципы

- **Три файла БД** — `queue.db`, `memory.db`, `audit.db`: изоляция отказов и раздельные границы snapshot/rollback (откат памяти не трогает очереди и аудит).
- **PRAGMA на каждое соединение:** `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`. Дисциплина одного писателя на файл (одно write-соединение в процессе).
- **Инварианты — в схеме, не только в коде:** CHECK-ограничения и триггеры дублируют логику ядра (fail-closed при баге в коде).
- **Время** — unix epoch миллисекунды, INTEGER.

## queue.db — очереди сообщений

Модель SQS: статус выражен временем видимости, claim атомарен.

```sql
CREATE TABLE messages (
  id           INTEGER PRIMARY KEY,
  queue        TEXT    NOT NULL CHECK (queue IN ('inbound','outbound')),
  payload      TEXT    NOT NULL,              -- JSON
  provenance   TEXT    NOT NULL CHECK (provenance IN ('owner','quarantine','scheduler','system')),
  created_at   INTEGER NOT NULL,
  visible_at   INTEGER NOT NULL,              -- <= now → доступно; > now → claimed/отложено
  claimed_by   TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  dead         INTEGER NOT NULL DEFAULT 0     -- dead letter: attempts исчерпаны
);
CREATE INDEX idx_messages_poll ON messages (queue, dead, visible_at);
```

Claim (атомарно, single-writer SQLite сериализует конкурентов):

```sql
UPDATE messages
SET visible_at = :now + :visibility_timeout_ms,
    claimed_by = :worker, attempts = attempts + 1
WHERE id = (SELECT id FROM messages
            WHERE queue = :q AND dead = 0 AND visible_at <= :now
            ORDER BY created_at LIMIT 1)
RETURNING *;
```

Успешная обработка → `DELETE`. Невидимое сообщение с истёкшим таймаутом возвращается само (visible_at в прошлом). `attempts >= max_attempts` → `dead=1` + уведомление владельцу (явная деградация, TOKEN_ECONOMY). Cron-задачи Scheduler публикуются сюда же с `provenance='scheduler'` — привилегированного пути нет.

### channel_state — состояние Telegram-канала (миграция 0002)

```sql
CREATE TABLE channel_state (
  key   TEXT PRIMARY KEY CHECK (key IN ('owner_user_id','updates_offset')),
  value TEXT NOT NULL
);
```

Пишет только Channel Adapter. `owner_user_id` — результат pairing'а, write-once (защита от переугона владельца обеспечивается кодом, повторная запись — ошибка); `updates_offset` — протокол getUpdates, обновляется после обработки батча (at-least-once: дубль при краше приемлем, потеря — нет). CHECK на `key` — закрытый список, расширение только миграцией.

### pending_actions — human-gate для необратимых действий (миграция 0003)

```sql
CREATE TABLE pending_actions (
  token        TEXT PRIMARY KEY,
  action_id    TEXT    NOT NULL,
  payload      TEXT    NOT NULL,              -- JSON (session_id и др.)
  chat_id      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed     INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
);
CREATE INDEX idx_pending_expires ON pending_actions (consumed, expires_at);
```

Пишет orchestrator (`create` при `confirm_required`), потребляет orchestrator (`consume` после `/approve`). Token одноразовый, TTL 15 мин (код). Не в audit.db — только операционное состояние очереди.

## memory.db — эпизодическая и семантическая память

### Эпизодическая

```sql
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
```

### Семантическая (знания и навыки)

```sql
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
```

### Evidence — отдельная таблица

FK-целостность, счётчики и типизация запросов; JSON-колонка не даёт ни того, ни другого.

```sql
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
```

### Переходы статусов — журнал + инварианты триггерами

```sql
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
```

Выборка в системный контекст будущих сессий — **только** `epistemic_status IN ('corroborated','verified')` (unverified живёт в staging и виден лишь по явному запросу владельца; refuted не грузится никогда).

### Снапшоты

```sql
CREATE TABLE snapshots (
  id         INTEGER PRIMARY KEY,
  path       TEXT    NOT NULL,   -- файл, созданный VACUUM INTO
  reason     TEXT    NOT NULL,   -- 'pre-curation' | 'pre-consolidation' | 'manual'
  created_at INTEGER NOT NULL
);
```

Перед любой мутирующей курацией: `VACUUM INTO '<snapshots_dir>/memory-<ts>.db'` (онлайн-копия без блокировки читателей), запись в `snapshots`, ретенция по числу/возрасту. Rollback = остановка писателя + подмена файла.

## audit.db — tamper-evident журнал

```sql
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  actor        TEXT    NOT NULL,   -- 'orchestrator' | 'gate' | 'scheduler' | 'curation' | ...
  action       TEXT    NOT NULL,
  action_class TEXT    CHECK (action_class IN ('read-only','reversible','irreversible')),
  decision     TEXT    NOT NULL CHECK (decision IN ('allow','deny','confirm_required','info')),
  payload_hash TEXT    NOT NULL,   -- sha256(JSON payload)
  prev_hash    TEXT    NOT NULL,   -- entry_hash предыдущей записи; у первой — 'genesis'
  entry_hash   TEXT    NOT NULL    -- sha256(ts|actor|action|decision|payload_hash|prev_hash), поля через '|'
);

-- Append-only: любые UPDATE/DELETE запрещены
CREATE TRIGGER audit_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TRIGGER audit_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
```

Append-only (UPDATE/DELETE запрещены триггерами RAISE(ABORT)); разрыв цепочки хешей обнаруживается детерминированной проверкой. Решения gate engine и budget engine пишутся сюда всегда.

## Открытые вопросы (не блокируют миграцию 0001)

- Ретенция эпизодов (размер БД у болтливого владельца) — политика в Sprint 5.
- Точный лимит evidence на знание и параметры decay — константы курации, тюнятся по метрикам Sprint 6.
- Показ staging владельцу без спама (LEARNING_LOOP) — UX-решение Sprint 6.
