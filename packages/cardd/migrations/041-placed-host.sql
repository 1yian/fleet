-- placed_host is the host a mate's connection reported in its hello, so a scoped reload enrolls
-- a mate by where its running process says it is, not by its lane name. Empty means unreported.
ALTER TABLE sessions ADD COLUMN placed_host TEXT NOT NULL DEFAULT '';
