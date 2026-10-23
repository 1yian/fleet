-- A runtime incident is one failure episode of one actor (a worker or a mate): a failed model turn,
-- or a process that went missing. It holds the sanitized cause, who owns the recovery, and the
-- recovery's progress. An actor has at most one live incident, so repeated observations of the same
-- episode add to it and a parent hears about the episode once.
ALTER TABLE sessions ADD COLUMN process TEXT;
ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN stopping INTEGER NOT NULL DEFAULT 0 CHECK (stopping IN (0, 1));
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL REFERENCES sessions (id),
  card INTEGER NOT NULL REFERENCES cards (id),
  parent TEXT,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('turn', 'compaction', 'startup', 'lost')),
  classification TEXT NOT NULL,
  error TEXT NOT NULL,
  source TEXT NOT NULL,
  intent TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'recovering', 'blocked', 'verified', 'cleared', 'superseded')),
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
CREATE UNIQUE INDEX one_live_incident ON incidents (actor) WHERE state IN ('open', 'recovering', 'blocked');
