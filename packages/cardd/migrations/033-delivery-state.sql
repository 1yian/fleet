-- One delivery state. A hello that finds the entry in the session file files it and does not
-- take it in. Only a settled run does that. intake and sessions.low_water go away: nothing
-- read low_water, and escalated had no writer.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE deliveries_new (
  session TEXT NOT NULL REFERENCES sessions (id),
  entry INTEGER NOT NULL REFERENCES entries (id),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'pushed', 'resent', 'pushed-again', 'filed', 'acknowledged', 'confirmed')
  ),
  updated_at INTEGER NOT NULL,
  resends INTEGER NOT NULL DEFAULT 0,
  told_at INTEGER,
  PRIMARY KEY (session, entry)
) STRICT, WITHOUT ROWID;

INSERT INTO deliveries_new (session, entry, state, updated_at, resends, told_at)
SELECT session, entry,
  CASE
    WHEN intake = 'taken' AND state = 'confirmed' THEN 'confirmed'
    WHEN intake = 'taken' THEN 'acknowledged'
    WHEN state = 'confirmed' THEN 'filed'
    WHEN state = 'pending' AND intake IN ('resent', 'escalated') THEN 'resent'
    WHEN state IN ('pushed', 'acknowledged') AND intake IN ('resent', 'escalated') THEN 'pushed-again'
    WHEN state = 'acknowledged' THEN 'pushed'
    ELSE state
  END,
  updated_at, resends, told_at
FROM deliveries;

DROP TABLE deliveries;
ALTER TABLE deliveries_new RENAME TO deliveries;

CREATE INDEX deliveries_not_taken ON deliveries (session)
  WHERE state IN ('pending', 'pushed', 'resent', 'pushed-again', 'filed');

ALTER TABLE sessions DROP COLUMN low_water;
