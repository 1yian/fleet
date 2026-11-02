-- A schedule is a message that cardd delivers to a lane at a time. owner is the lane that made it.
-- at is the local time HH:MM in timezone. days is a JSON list of weekdays, or NULL for every day.
-- on_date is the local date of a one-shot schedule, or NULL for a recurring one. fired is the local
-- minute of the latest slot already delivered, so a restart repeats none.
CREATE TABLE schedules (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES lanes (name),
  recipient TEXT NOT NULL REFERENCES lanes (name),
  at TEXT NOT NULL,
  days TEXT CHECK (days IS NULL OR json_valid(days)),
  on_date TEXT,
  timezone TEXT NOT NULL,
  text TEXT NOT NULL,
  since INTEGER NOT NULL,
  fired TEXT
) STRICT;
