CREATE INDEX cards_by_status ON cards (status);

CREATE INDEX entries_by_card ON entries (card, id);

CREATE UNIQUE INDEX one_card_grant ON grants (card) WHERE card IS NOT NULL AND ended_at IS NULL;

CREATE UNIQUE INDEX one_live_attempt ON attempts (card) WHERE state IN ('starting', 'active');

CREATE UNIQUE INDEX one_mate_per_lane ON sessions (lane) WHERE role = 'mate';

CREATE UNIQUE INDEX one_open_finding ON findings (card, condition) WHERE cleared_at IS NULL;

CREATE UNIQUE INDEX one_run_per_tick ON cards (parent, tick) WHERE tick IS NOT NULL;

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  card INTEGER NOT NULL REFERENCES cards (id),
  n INTEGER NOT NULL CHECK (n >= 1),
  host TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'ended', 'replaced')),
  pane TEXT,
  worktree TEXT,
  session_file TEXT,
  branch TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (card, n)
) STRICT;

CREATE TABLE card_blockers (
  card INTEGER NOT NULL REFERENCES cards (id),
  blocked_by INTEGER NOT NULL REFERENCES cards (id),
  PRIMARY KEY (card, blocked_by),
  CHECK (card <> blocked_by)
) STRICT, WITHOUT ROWID;

CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  lane TEXT NOT NULL REFERENCES lanes (name),
  project TEXT REFERENCES projects (name),
  kind TEXT NOT NULL CHECK (kind IN ('ship', 'scout', 'captain', 'standing')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'working', 'in-review', 'with-mate', 'with-first-mate',
      'needs-you', 'merging', 'waiting', 'done', 'dropped'
    )
  ),
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
  delivery TEXT CHECK (delivery IN ('no-mistakes', 'direct-PR', 'local-only')),
  base_branch TEXT,
  profile TEXT CHECK (json_valid(profile)),
  pr TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  last_activity INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
  CHECK (kind = 'standing' OR (schedule IS NULL AND runner IS NULL)),
  CHECK (kind = 'ship' OR delivery IS NULL),
  CHECK ((held_until IS NULL) = (return_status IS NULL)),
  CHECK (tick IS NULL OR parent IS NOT NULL)
) STRICT;

CREATE TABLE deliveries (
  session TEXT NOT NULL REFERENCES sessions (id),
  entry INTEGER NOT NULL REFERENCES entries (id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'pushed', 'acknowledged', 'confirmed')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session, entry)
) STRICT, WITHOUT ROWID;

CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  card INTEGER NOT NULL REFERENCES cards (id),
  author TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'comment', 'report', 'ask', 'answer', 'status', 'merge', 'cleanup', 'connect',
      'disconnect', 'finding', 'grant', 'note', 'job-result', 'review-feedback'
    )
  ),
  body TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields)),
  attempt INTEGER REFERENCES attempts (id),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  card INTEGER NOT NULL REFERENCES cards (id),
  condition TEXT NOT NULL,
  entry INTEGER REFERENCES entries (id),
  opened_at INTEGER NOT NULL,
  cleared_at INTEGER
) STRICT;

CREATE TABLE grants (
  id INTEGER PRIMARY KEY,
  lane TEXT REFERENCES lanes (name),
  card INTEGER REFERENCES cards (id),
  words TEXT NOT NULL,
  source_entry INTEGER REFERENCES entries (id),
  may TEXT NOT NULL,
  limits TEXT NOT NULL DEFAULT '',
  always_asks TEXT NOT NULL DEFAULT '',
  reports TEXT NOT NULL DEFAULT '',
  scope_project TEXT REFERENCES projects (name),
  scope_branch TEXT,
  expires INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER, merge INTEGER NOT NULL DEFAULT 0 CHECK (merge IN (0, 1)),
  CHECK ((lane IS NULL) <> (card IS NULL)),
  CHECK (scope_branch IS NULL OR scope_project IS NOT NULL)
) STRICT;

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  attempt INTEGER NOT NULL REFERENCES attempts (id),
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  tab TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'lost')),
  exit_code INTEGER,
  output_tail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'finished') = (exit_code IS NOT NULL))
) STRICT;

CREATE TABLE lanes (
  name TEXT PRIMARY KEY,
  home TEXT NOT NULL,
  hosts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hosts)),
  charter TEXT NOT NULL DEFAULT '',
  parent TEXT REFERENCES lanes (name)
, card INTEGER REFERENCES cards (id)) STRICT;

CREATE TABLE projects (
  name TEXT PRIMARY KEY,
  clones TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(clones)),
  delivery TEXT NOT NULL CHECK (
    delivery IN ('no-mistakes', 'direct-PR', 'local-only', 'no-mistakes-prod-only')
  ),
  branch_prefix TEXT NOT NULL DEFAULT '',
  default_base TEXT NOT NULL DEFAULT 'main',
  profile TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(profile)),
  capacity INTEGER NOT NULL DEFAULT 2 CHECK (capacity >= 0)
) STRICT;

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  value BLOB NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('mate', 'worker')),
  lane TEXT NOT NULL REFERENCES lanes (name),
  attempt INTEGER UNIQUE REFERENCES attempts (id),
  host TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN ('starting', 'idle', 'running', 'waiting', 'exited', 'lost', 'closed')
  ),
  low_water INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER,
  CHECK ((role = 'worker') = (attempt IS NOT NULL))
) STRICT;

CREATE TRIGGER card_revision AFTER UPDATE ON cards
WHEN NEW.revision = OLD.revision
BEGIN
  UPDATE cards SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;

CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries
BEGIN
  SELECT RAISE (ABORT, 'entries are append-only');
END;

CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries
BEGIN
  SELECT RAISE (ABORT, 'entries are append-only');
END;
