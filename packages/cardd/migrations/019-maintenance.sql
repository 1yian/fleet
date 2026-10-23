-- A maintenance request asks one live session to reload or stow at its next safe point.
-- It is never an interruption: the session answers when it is idle with nothing running.
-- A reload is verified only when the session reconnects on a new process.
ALTER TABLE sessions ADD COLUMN maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1));
CREATE TABLE maintenance (
  id INTEGER PRIMARY KEY,
  batch TEXT NOT NULL,
  requester TEXT NOT NULL REFERENCES sessions (id),
  session TEXT NOT NULL REFERENCES sessions (id),
  kind TEXT NOT NULL CHECK (kind IN ('reload', 'stow')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'reloading', 'completed', 'failed')),
  process TEXT,
  detail TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (batch, session)
) STRICT;
