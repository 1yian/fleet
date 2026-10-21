-- A card's status is worked out from its entries when it is read, so the stored status, the
-- phase, and the time of the last status change go away. A closed card keeps its place: one
-- that has no cleanup entry gets one that says how it ended.
INSERT INTO entries (card, author, kind, body, fields, created_at)
SELECT id, 'fleet', 'cleanup', 'closed before status was worked out from reports',
  json_object('outcome', phase, 'archives', json('[]'), 'left', json('[]')), updated_at
FROM cards
WHERE phase IN ('done', 'dropped')
  AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.card = cards.id AND e.kind = 'cleanup');

DROP INDEX cards_by_status;
ALTER TABLE cards DROP COLUMN status;
ALTER TABLE cards DROP COLUMN phase;
ALTER TABLE cards DROP COLUMN updated_at;
