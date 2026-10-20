-- A card's short name, like a task ID. herdr shows it for the card's worker.
ALTER TABLE cards ADD COLUMN name TEXT NOT NULL DEFAULT '';
