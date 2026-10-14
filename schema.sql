-- Households share one key; everyone with the key (via the invite link) can use the calendar.
CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  tz TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Members, events and to-dos, stored as JSON documents per household.
CREATE TABLE IF NOT EXISTS items (
  household_id TEXT NOT NULL,
  col TEXT NOT NULL CHECK (col IN ('members','events','todos')),
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, col, id)
);

-- One private forwarding address per person: <name>.<token>@EMAIL_DOMAIN
CREATE TABLE IF NOT EXISTS inboxes (
  token TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inboxes_member ON inboxes (household_id, member_id);

-- A log of forwarded emails so people can see what was picked up.
CREATE TABLE IF NOT EXISTS inbound (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  from_addr TEXT,
  subject TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS inbound_household ON inbound (household_id, received_at);
