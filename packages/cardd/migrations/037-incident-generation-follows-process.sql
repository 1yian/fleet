DELETE FROM deliveries
WHERE state <> 'confirmed'
  AND entry IN (
    SELECT e.id FROM entries e JOIN incidents i ON i.card = e.card
    WHERE e.kind = 'finding' AND e.author = 'check'
      AND i.state IN ('open', 'blocked')
      AND i.generation < (SELECT s.generation FROM sessions s WHERE s.id = i.actor)
      AND instr(e.body, 'restart_card(card=' || i.card || ', incident=' || i.id || ', generation=' || i.generation || ',') > 0
  );

UPDATE incidents
SET generation = (SELECT s.generation FROM sessions s WHERE s.id = incidents.actor),
    due_told = 0
WHERE state IN ('open', 'blocked')
  AND generation < (SELECT s.generation FROM sessions s WHERE s.id = incidents.actor);
