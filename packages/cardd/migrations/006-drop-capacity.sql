-- Fleet no longer caps the workers on a project. Drops the per-project capacity column,
-- whatever value an existing database holds in it.
ALTER TABLE projects DROP COLUMN capacity;
