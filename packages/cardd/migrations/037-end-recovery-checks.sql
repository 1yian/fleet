-- A recovery check is a probe, not work. Its delivery ends when its incident leaves recovering,
-- whether the incident verified, failed, cleared, or was superseded. Before that, a check whose
-- incident had ended kept an unread delivery, was resent every intake interval, and made main hear
-- "missed" for it. This drops the deliveries of every recovery check whose incident is not
-- recovering it now, and of the missed findings already issued for those checks. The entries stay.
DELETE FROM deliveries
WHERE entry IN (
  SELECT e.id FROM entries e
  WHERE e.kind = 'comment' AND json_extract(e.fields, '$.recovery') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM incidents i WHERE i.state = 'recovering' AND i.recovery_entry = e.id
    )
)
OR entry IN (
  SELECT f.id FROM entries f
  WHERE f.kind = 'finding' AND json_extract(f.fields, '$.condition') = 'missed'
    AND json_extract(f.fields, '$.entry') IN (
      SELECT e.id FROM entries e
      WHERE e.kind = 'comment' AND json_extract(e.fields, '$.recovery') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM incidents i WHERE i.state = 'recovering' AND i.recovery_entry = e.id
        )
    )
);
