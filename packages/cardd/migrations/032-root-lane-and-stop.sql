CREATE UNIQUE INDEX one_root_lane ON lanes ((1)) WHERE parent IS NULL;

ALTER TABLE sessions ADD COLUMN stopping_until INTEGER;
UPDATE sessions SET stopping_until = unixepoch('now') * 1000 + 240000 WHERE stopping = 1;
ALTER TABLE sessions DROP COLUMN stopping;
