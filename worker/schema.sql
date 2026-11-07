-- P&C Volunteer Sign-up: database schema (Cloudflare D1 / SQLite)
-- Paste this whole file into the D1 console once, when setting up.

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  published    INTEGER NOT NULL DEFAULT 0,   -- 0 = draft (hidden), 1 = visible to volunteers
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,                 -- e.g. "BBQ cooking"
  details      TEXT NOT NULL DEFAULT '',      -- what the task involves
  date         TEXT NOT NULL,                 -- YYYY-MM-DD (Sydney local)
  start_time   TEXT NOT NULL,                 -- HH:MM (Sydney local)
  end_time     TEXT NOT NULL,                 -- HH:MM (Sydney local)
  capacity     INTEGER NOT NULL DEFAULT 1,
  start_utc    TEXT NOT NULL,                 -- ISO UTC, used for reminders and sorting
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_slots_event ON slots(event_id);
CREATE INDEX IF NOT EXISTS idx_slots_start ON slots(start_utc);

CREATE TABLE IF NOT EXISTS signups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id       INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  mobile        TEXT NOT NULL,
  comments      TEXT NOT NULL DEFAULT '',
  manage_token  TEXT NOT NULL,                -- private link token, shared by one submission
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signups_slot ON signups(slot_id);
CREATE INDEX IF NOT EXISTS idx_signups_token ON signups(manage_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signups_unique ON signups(slot_id, email);

-- Outgoing email queue. Lets the site stay under the Microsoft daily sending limit.
CREATE TABLE IF NOT EXISTS email_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email    TEXT NOT NULL,
  reply_to    TEXT,
  subject     TEXT NOT NULL,
  html        TEXT NOT NULL,
  ics         TEXT,                            -- optional calendar attachment
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_status ON email_queue(status, sent_at);

-- Failed admin logins, for simple lockout.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip         TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
