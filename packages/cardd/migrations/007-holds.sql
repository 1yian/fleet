-- One hold per card (spec section 17). A hold replaces the asks, and the card's status
-- is derived from the hold and the card's phase, so it is never set by hand.

-- The entries table lists its kinds in a CHECK, so adding 'hold' and 'release' means
-- rebuilding it. Every ask becomes a hold. Foreign keys are checked at the commit, after
-- the children point at the new table again.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE entries_new (
  id INTEGER PRIMARY KEY,
  card INTEGER NOT NULL REFERENCES cards (id),
  author TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'comment', 'report', 'hold', 'release', 'answer', 'status', 'merge', 'cleanup', 'connect',
      'disconnect', 'finding', 'grant', 'note', 'job-result', 'review-feedback'
    )
  ),
  body TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields)),
  attempt INTEGER REFERENCES attempts (id),
  created_at INTEGER NOT NULL
) STRICT;

INSERT INTO entries_new (id, card, author, kind, body, fields, attempt, created_at)
SELECT id, card, author, CASE kind WHEN 'ask' THEN 'hold' ELSE kind END, body, fields, attempt,
  created_at
FROM entries;

DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;

CREATE INDEX entries_by_card ON entries (card, id);

-- Entries are the record. They are never changed or removed.
CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries
BEGIN
  SELECT RAISE (ABORT, 'entries are append-only');
END;

CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries
BEGIN
  SELECT RAISE (ABORT, 'entries are append-only');
END;

-- A card's phase is where its work stands, whatever holds it: queued, working, in review,
-- with its mate, merging, or closed. Its status is the phase seen through its hold.
ALTER TABLE cards ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued' CHECK (
  phase IN ('queued', 'working', 'in-review', 'with-mate', 'merging', 'done', 'dropped')
);

UPDATE cards SET phase = CASE
  WHEN status IN ('needs-you', 'with-first-mate') THEN 'with-mate'
  WHEN status = 'waiting' THEN coalesce(
    CASE WHEN return_status IN ('queued', 'working', 'in-review', 'merging') THEN return_status END,
    'with-mate')
  ELSE status
END;

-- A card held until a date keeps its date in a hold entry. The old columns stay but are unused.
INSERT INTO entries (card, author, kind, body, fields, created_at)
SELECT id, 'fleet', 'hold', 'held until a date', json_object('holder', 'owner', 'until', held_until),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM cards WHERE status = 'waiting' AND held_until IS NOT NULL;

-- A card that was With first mate was already on the board's Needs you, and its ask is now a
-- hold of the captain's.
UPDATE cards SET status = 'needs-you' WHERE status = 'with-first-mate';
UPDATE cards SET held_until = NULL, return_status = NULL;
