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

-- Emails a person chose to forward. Nothing is added to the calendar from them until that
-- person reviews the email in the app and picks what to add; the email's text is then deleted.
CREATE TABLE IF NOT EXISTS inbound (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  from_addr TEXT,
  subject TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,          -- pending | added | dismissed | expired | too_large
  event_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT                   -- the email's text, invites and found dates while pending; NULL afterwards
);
CREATE INDEX IF NOT EXISTS inbound_household ON inbound (household_id, received_at);
