-- A validation is one drive of a no-mistakes run for a card: the worker's validate tool starts it, and
-- its wrapper posts what the run did. It binds the card to the run id. launch is the nonce the run
-- was started with, so a repeated start reuses the run. previous names the failed validation that a
-- revalidate reran, so the history of a card's runs stays in one chain on the same card.
-- told_at is set in the same transaction as the one parent notice of a failed run.
CREATE TABLE validations (
  id INTEGER PRIMARY KEY,
  card INTEGER NOT NULL REFERENCES cards (id),
  attempt INTEGER NOT NULL REFERENCES attempts (id),
  actor TEXT NOT NULL REFERENCES sessions (id),
  parent TEXT,
  launch TEXT NOT NULL,
  run TEXT,
  state TEXT NOT NULL CHECK (state IN ('launching', 'running', 'gated', 'passed', 'cancelled', 'failed', 'unavailable')),
  outcome TEXT,
  classification TEXT,
  error TEXT,
  previous INTEGER REFERENCES validations (id),
  recovery_key TEXT,
  generation INTEGER NOT NULL,
  told_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX validations_card ON validations (card);
CREATE UNIQUE INDEX one_revalidation ON validations (previous) WHERE previous IS NOT NULL;
