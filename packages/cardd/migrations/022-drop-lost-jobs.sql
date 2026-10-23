-- dropped_at is when a worker or its mate dropped a lost job. The job stays recorded as lost, and the timed check stops reminding about it.
ALTER TABLE jobs ADD COLUMN dropped_at INTEGER;
