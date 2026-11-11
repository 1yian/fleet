-- The model a worker is pinned to, as provider/id. An attempt without one uses its lane's normal
-- model selection. It was recorded in the attempt's first task entry, which cannot change. It is a
-- column now so that the card's mate can replace it on a restart. Every attempt made before this
-- keeps the model its task entry named.
ALTER TABLE attempts ADD COLUMN model TEXT;
UPDATE attempts SET model = (
  SELECT json_extract(e.fields, '$.model')
  FROM entries e
  JOIN deliveries d ON d.entry = e.id
  JOIN sessions s ON s.id = d.session
  WHERE s.attempt = attempts.id AND json_extract(e.fields, '$.task') = 1
  ORDER BY e.id
  LIMIT 1
);
