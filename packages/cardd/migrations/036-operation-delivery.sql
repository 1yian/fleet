CREATE TABLE cards_new (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  lane TEXT NOT NULL REFERENCES lanes (name),
  project TEXT REFERENCES projects (name),
  kind TEXT NOT NULL CHECK (kind IN ('ship', 'scout', 'captain', 'standing')),
  held_until INTEGER,
  return_status TEXT CHECK (
    return_status IN (
      'queued', 'working', 'in-review', 'with-mate', 'with-first-mate', 'needs-you', 'merging'
    )
  ),
  parent INTEGER REFERENCES cards (id),
  tick INTEGER,
  schedule TEXT CHECK (json_valid(schedule)),
  runner TEXT CHECK (runner IN ('mate', 'worker')),
  intent TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL DEFAULT '',
  delivery TEXT CHECK (delivery IN ('no-mistakes', 'direct-PR', 'local-only', 'ops')),
  base_branch TEXT,
  profile TEXT CHECK (json_valid(profile)),
  pr TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  last_activity INTEGER,
  created_at INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  plan TEXT CHECK (json_valid(plan)),
  plan_next TEXT CHECK (json_valid(plan_next)),
  historical_project TEXT,
  CHECK (kind = 'standing' OR (schedule IS NULL AND runner IS NULL)),
  CHECK (kind = 'ship' OR delivery IS NULL),
  CHECK (delivery IS NOT 'ops' OR pr IS NULL),
  CHECK ((held_until IS NULL) = (return_status IS NULL)),
  CHECK (tick IS NULL OR parent IS NOT NULL)
) STRICT;

INSERT INTO cards_new SELECT * FROM cards;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;

CREATE UNIQUE INDEX one_run_per_tick ON cards (parent, tick) WHERE tick IS NOT NULL;
CREATE TRIGGER card_revision AFTER UPDATE ON cards
WHEN NEW.revision = OLD.revision
BEGIN
  UPDATE cards SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
