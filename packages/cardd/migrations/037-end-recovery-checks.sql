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

UPDATE deliveries SET state = 'read'
WHERE state IN ('pushed', 'pushed-again') AND (session, entry) IN (
  SELECT i.actor, i.recovery_entry FROM incidents i JOIN sessions s ON s.id = i.actor
  WHERE i.state = 'recovering' AND i.control_at IS NOT NULL AND s.role = 'worker'
);
