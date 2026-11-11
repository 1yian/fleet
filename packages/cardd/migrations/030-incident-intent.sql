-- Incident state and intent are a closed set. Adding the intent CHECK means rebuilding the table.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE incidents_new (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL REFERENCES sessions (id),
  card INTEGER NOT NULL REFERENCES cards (id),
  parent TEXT,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('turn', 'compaction', 'startup', 'lost')),
  classification TEXT NOT NULL,
  error TEXT NOT NULL,
  source TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (
    intent IN (
      'working', 'paused', 'completed', 'closed', 'queued', 'with-mate', 'needs-you', 'waiting',
      'merging'
    )
  ),
  state TEXT NOT NULL CHECK (
    state IN ('open', 'recovering', 'blocked', 'verified', 'cleared', 'superseded')
  ),
  count INTEGER NOT NULL DEFAULT 1,
  retries INTEGER NOT NULL DEFAULT 0,
  replacements INTEGER NOT NULL DEFAULT 0,
  eligible_at INTEGER,
  due_told INTEGER NOT NULL DEFAULT 0,
  recovery_key TEXT,
  recovery_mode TEXT CHECK (recovery_mode IN ('retry', 'replace')),
  recovery_entry INTEGER REFERENCES entries (id),
  recovery_deadline INTEGER,
  control_at INTEGER,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  closed_at INTEGER
) STRICT;

INSERT INTO incidents_new (
  id, actor, card, parent, generation, phase, classification, error, source, intent, state, count,
  retries, replacements, eligible_at, due_told, recovery_key, recovery_mode, recovery_entry,
  recovery_deadline, control_at, first_at, last_at, closed_at
)
SELECT
  id, actor, card, parent, generation, phase, classification, error, source, intent, state, count,
  retries, replacements, eligible_at, due_told, recovery_key, recovery_mode, recovery_entry,
  recovery_deadline, control_at, first_at, last_at, closed_at
FROM incidents;

DROP TABLE incidents;
ALTER TABLE incidents_new RENAME TO incidents;

CREATE UNIQUE INDEX one_live_incident ON incidents (actor)
  WHERE state IN ('open', 'recovering', 'blocked');
