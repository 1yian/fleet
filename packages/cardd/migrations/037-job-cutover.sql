ALTER TABLE jobs ADD COLUMN launch_id TEXT;
ALTER TABLE jobs ADD COLUMN wrapper_pid INTEGER CHECK (wrapper_pid IS NULL OR (wrapper_pid > 0 AND launch_id IS NOT NULL));
CREATE UNIQUE INDEX jobs_launch_id ON jobs (launch_id) WHERE launch_id IS NOT NULL;

CREATE TABLE job_cutover (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sealed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE job_stop_confirmations (
  job INTEGER PRIMARY KEY REFERENCES jobs (id),
  confirmed_at INTEGER NOT NULL,
  evidence TEXT NOT NULL
) STRICT;

CREATE TRIGGER jobs_refuse_legacy_after_seal
BEFORE INSERT ON jobs
WHEN NEW.launch_id IS NULL AND EXISTS (SELECT 1 FROM job_cutover)
BEGIN
  SELECT RAISE (ABORT, 'Legacy job launches are sealed. Reload the worker before starting another job');
END;

CREATE TRIGGER jobs_revoke_stop_confirmation_on_revival
AFTER UPDATE OF state ON jobs
WHEN OLD.state != 'running' AND NEW.state = 'running'
BEGIN
  DELETE FROM job_stop_confirmations WHERE job = NEW.id;
END;
