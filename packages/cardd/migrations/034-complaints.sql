-- A complaint is one sentence an agent recorded when it was asked whether anything about the system
-- annoyed it. It is feedback only. It keeps who said it (session, role, lane), when, and the card
-- and project it was about, as plain values and not as references: a lane's removal deletes its
-- cards and sessions, and the complaint stays.
CREATE TABLE complaints (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('mate', 'worker')),
  lane TEXT NOT NULL,
  card INTEGER,
  project TEXT,
  text TEXT NOT NULL
) STRICT;
CREATE INDEX complaints_by_lane ON complaints (lane, id);
