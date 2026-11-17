CREATE TABLE maintenance_batches (
  batch TEXT NOT NULL,
  requester TEXT NOT NULL REFERENCES sessions (id),
  maintenance INTEGER NOT NULL REFERENCES maintenance (id),
  PRIMARY KEY (batch, maintenance)
) STRICT;
INSERT INTO maintenance_batches (batch, requester, maintenance)
SELECT batch, requester, id FROM maintenance;
