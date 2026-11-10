-- A job is running, lost, finished, or abandoned. dropped_at is set only while lost.
-- Ending an attempt cannot leave a job running. A running job whose attempt already ended is abandoned.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE jobs_new (
  id INTEGER PRIMARY KEY,
  attempt INTEGER NOT NULL REFERENCES attempts (id),
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  tab TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'lost', 'finished', 'abandoned')),
  exit_code INTEGER,
  output_tail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dropped_at INTEGER,
  CHECK ((state = 'finished') = (exit_code IS NOT NULL)),
  CHECK (dropped_at IS NULL OR state = 'lost')
) STRICT;

INSERT INTO jobs_new (
  id, attempt, label, command, tab, state, exit_code, output_tail, created_at, updated_at, dropped_at
)
SELECT
  j.id,
  j.attempt,
  j.label,
  j.command,
  j.tab,
  CASE
    WHEN j.state = 'running' AND a.state NOT IN ('starting', 'active') THEN 'abandoned'
    ELSE j.state
  END,
  j.exit_code,
  j.output_tail,
  j.created_at,
  CASE
    WHEN j.state = 'running' AND a.state NOT IN ('starting', 'active') THEN a.updated_at
    ELSE j.updated_at
  END,
  CASE WHEN j.state = 'lost' THEN j.dropped_at ELSE NULL END
FROM jobs j
JOIN attempts a ON a.id = j.attempt
UNION ALL
SELECT id, attempt, label, command, tab, 'orphan', exit_code, output_tail, created_at, updated_at, NULL
FROM jobs
WHERE NOT EXISTS (SELECT 1 FROM attempts a WHERE a.id = jobs.attempt);

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE TRIGGER jobs_running_needs_live_attempt
BEFORE INSERT ON jobs
WHEN NEW.state = 'running'
  AND (SELECT state FROM attempts WHERE id = NEW.attempt) NOT IN ('starting', 'active')
BEGIN
  SELECT RAISE (ABORT, 'a running job needs a live attempt');
END;

CREATE TRIGGER jobs_revive_needs_live_attempt
BEFORE UPDATE OF state ON jobs
WHEN NEW.state = 'running'
  AND OLD.state != 'running'
  AND (SELECT state FROM attempts WHERE id = NEW.attempt) NOT IN ('starting', 'active')
BEGIN
  SELECT RAISE (ABORT, 'a running job needs a live attempt');
END;

CREATE TRIGGER attempts_refuse_running_jobs
BEFORE UPDATE OF state ON attempts
WHEN NEW.state NOT IN ('starting', 'active')
  AND OLD.state IN ('starting', 'active')
  AND EXISTS (SELECT 1 FROM jobs WHERE attempt = NEW.id AND state = 'running')
BEGIN
  SELECT RAISE (ABORT, 'end the attempt only after its running jobs leave running');
END;
