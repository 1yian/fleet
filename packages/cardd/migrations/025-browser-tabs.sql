-- A browser tab is one tab of the fleet's shared Chrome. card owns it, and target is Chrome's id for
-- it. A tab that cardd closed, or found gone, keeps its row with closed_at set, so the table also
-- records which card held which tab.
CREATE TABLE browser_tabs (
  target TEXT PRIMARY KEY,
  card INTEGER NOT NULL REFERENCES cards (id),
  label TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
) STRICT;
CREATE INDEX browser_tabs_open ON browser_tabs (card) WHERE closed_at IS NULL;
