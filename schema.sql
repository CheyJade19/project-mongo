-- People who use the app. They sign in with Apple, Google, or a one-time code sent by email.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- How each person signs in (one person can have several: Apple, Google, email).
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL CHECK (provider IN ('apple','google','email')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id);

-- Signed-in devices. Only a hash of each device's token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Pending one-time sign-in codes (hashed), at most one per address.
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tz TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who can see and edit each household. The owner can invite, remove people and delete it.
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, household_id)
);
CREATE INDEX IF NOT EXISTS memberships_household ON memberships (household_id);

-- Invite codes expire after 7 days or 10 uses.
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  uses_left INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_household ON invites (household_id);

-- Profiles (members), events and to-dos, stored as JSON documents per household.
CREATE TABLE IF NOT EXISTS items (
  household_id TEXT NOT NULL,
  col TEXT NOT NULL CHECK (col IN ('members','events','todos')),
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, col, id)
);

-- One private forwarding address per profile: <name>.<token>@EMAIL_DOMAIN
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
  status TEXT NOT NULL,          -- pending | added | dismissed | expired | too_large | over_limit
  event_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT                   -- the email's text, invites and found dates while pending; NULL afterwards
);
CREATE INDEX IF NOT EXISTS inbound_household ON inbound (household_id, received_at);
CREATE INDEX IF NOT EXISTS inbound_member ON inbound (member_id, received_at);

-- Profile photos, resized on the device before upload. Each is served at /api/photo/<id>, an
-- unguessable address only the household's app knows. Replacing or removing a photo deletes it.
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS photos_member ON photos (household_id, member_id);
