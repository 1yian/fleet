ALTER TABLE jobs ADD COLUMN registered_at INTEGER CHECK (registered_at IS NULL OR launch_id IS NOT NULL);
