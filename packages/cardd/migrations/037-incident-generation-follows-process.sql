UPDATE incidents
SET generation = (SELECT s.generation FROM sessions s WHERE s.id = incidents.actor)
WHERE state IN ('open', 'blocked')
  AND generation < (SELECT s.generation FROM sessions s WHERE s.id = incidents.actor);
