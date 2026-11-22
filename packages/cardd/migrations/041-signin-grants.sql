CREATE TABLE signin_grants (
  id TEXT PRIMARY KEY,
  entry INTEGER NOT NULL REFERENCES entries (id),
  lane TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT,
  span_start INTEGER,
  span_end INTEGER,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  CHECK ((span_start IS NULL) = (span_end IS NULL))
) STRICT;
