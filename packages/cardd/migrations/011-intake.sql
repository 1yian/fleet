-- Whether the receiving model took a delivery in: a run that held it in context ended without an
-- abort or an error. A mate's delivery that waits too long is sent once more, then escalated once.
-- Every delivery made before this counts as taken, so nothing old is sent again.
ALTER TABLE deliveries ADD COLUMN intake TEXT NOT NULL DEFAULT 'waiting'
  CHECK (intake IN ('waiting', 'resent', 'escalated', 'taken'));
UPDATE deliveries SET intake = 'taken';
CREATE INDEX deliveries_not_taken ON deliveries (session) WHERE intake IN ('waiting', 'resent');
