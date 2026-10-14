-- One-time step when moving a test database from household keys to accounts.
-- The old households table required a key; accounts replace it. This deletes the old test data
-- (households, profiles, events, to-dos and forwarded emails). Run it once, before schema.sql:
--   npx wrangler d1 execute household-calendar --remote --file=scripts/reset-before-accounts.sql
DROP TABLE IF EXISTS inbound;
DROP TABLE IF EXISTS inboxes;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS households;
