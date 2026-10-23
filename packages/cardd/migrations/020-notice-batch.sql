-- A session holds routine notices for a batch window. batch_since is the clock time of the first
-- notice held, and is empty when nothing is held.
ALTER TABLE sessions ADD COLUMN batch_since INTEGER;
