-- resends counts how many times a delivery was sent again unread, and told_at is when the owner last
-- heard that it stayed unread. turn_since is when a session's current model turn began, and
-- progress_at is when it last changed a file or committed, so a turn that runs long with neither
-- can be told apart from a worker that is making progress.
ALTER TABLE deliveries ADD COLUMN resends INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN told_at INTEGER;
ALTER TABLE sessions ADD COLUMN turn_since INTEGER;
ALTER TABLE sessions ADD COLUMN progress_at INTEGER;
