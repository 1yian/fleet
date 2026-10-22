-- The captain's switch for the whole fleet. While a row exists, no new worker starts and no wake is
-- sent. Running workers and mates go on, so the captain keeps talking to them.
CREATE TABLE pause (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  since INTEGER NOT NULL,
  by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
) STRICT;
