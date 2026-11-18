CREATE TABLE maintenance_batches (
  batch TEXT NOT NULL,
  requester TEXT NOT NULL REFERENCES sessions (id),
  maintenance INTEGER REFERENCES maintenance (id),
  gone TEXT CHECK (gone IN ('failed', 'removed')),
  host TEXT NOT NULL DEFAULT '',
  CHECK ((maintenance IS NULL) = (gone IS NOT NULL)),
  UNIQUE (batch, maintenance)
) STRICT;
ALTER TABLE maintenance ADD COLUMN runtime TEXT;
ALTER TABLE sessions ADD COLUMN runtime TEXT;
