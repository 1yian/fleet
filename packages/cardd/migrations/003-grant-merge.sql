-- Whether a grant covers merging, such as "may merge when CI is green".
ALTER TABLE grants ADD COLUMN merge INTEGER NOT NULL DEFAULT 0 CHECK (merge IN (0, 1));
