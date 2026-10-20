-- A lane card: the standing card of a second mate's lane (spec section 6.3). Main
-- and the second mate talk by comments on it. It stays Waiting and is never closed.
ALTER TABLE lanes ADD COLUMN card INTEGER REFERENCES cards (id);

INSERT INTO cards (title, name, lane, kind, status, created_at, updated_at)
SELECT name, name, name, 'standing', 'waiting',
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM lanes WHERE parent IS NOT NULL ORDER BY name;

UPDATE lanes SET card = (SELECT id FROM cards WHERE kind = 'standing' AND lane = lanes.name)
WHERE parent IS NOT NULL;
