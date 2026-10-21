-- Whether the worker chose its branch's name. A new attempt starts on a placeholder, the attempt's
-- session name, and the worker names the branch once. Every attempt made before this keeps the
-- branch it has: it counts as named, so its name never changes.
ALTER TABLE attempts ADD COLUMN branch_named INTEGER NOT NULL DEFAULT 1 CHECK (branch_named IN (0, 1));
