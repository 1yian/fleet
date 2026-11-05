-- Each host runs its own Chrome. host names the host whose Chrome holds the tab, the same name
-- that attempts.host and the --browser option use. A row from before hosts had their own Chrome has
-- no host and cannot be reached any more, so it is retired.
ALTER TABLE browser_tabs ADD COLUMN host TEXT NOT NULL DEFAULT '';
UPDATE browser_tabs SET closed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE closed_at IS NULL;
