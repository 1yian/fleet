WITH recovery_checks AS MATERIALIZED (
  SELECT e.id, e.card, i.id AS active
  FROM entries e LEFT JOIN incidents i
    ON i.id = json_extract(e.fields, '$.recovery')
    AND i.recovery_entry = e.id AND i.state = 'recovering'
  WHERE e.kind = 'comment' AND json_extract(e.fields, '$.recovery') IS NOT NULL
)
DELETE FROM deliveries WHERE entry IN (
  SELECT id FROM recovery_checks WHERE active IS NULL
  UNION ALL
  SELECT f.id FROM recovery_checks e JOIN entries f ON f.card = e.card
  WHERE f.author = 'check' AND f.kind = 'finding'
    AND json_extract(f.fields, '$.condition') = 'missed'
    AND json_extract(f.fields, '$.entry') = e.id
);

UPDATE deliveries AS d SET state = 'read'
WHERE d.state IN ('pushed', 'pushed-again') AND EXISTS (
  SELECT 1 FROM entries e JOIN incidents i ON i.id = json_extract(e.fields, '$.recovery')
  JOIN entries r ON r.card = e.card AND r.id > e.id
  WHERE e.id = d.entry AND i.recovery_entry = e.id AND i.actor = d.session
    AND i.state = 'recovering' AND r.kind = 'report' AND r.author = 'worker:' || d.session
    AND r.created_at >= d.updated_at
);
