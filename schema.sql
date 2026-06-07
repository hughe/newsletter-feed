-- Newsletter email storage
CREATE TABLE IF NOT EXISTS emails (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT UNIQUE,          -- RFC Message-ID, used to dedupe
  from_addr   TEXT NOT NULL,        -- original sender (best-effort)
  from_name   TEXT,                 -- display name if present
  subject     TEXT NOT NULL,
  html        TEXT NOT NULL,        -- HTML body served in the feed
  text        TEXT,                 -- plaintext fallback
  received_at INTEGER NOT NULL      -- unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails (received_at DESC);

-- Emails that could not be parsed or had no usable HTML body.
-- raw is stored so a failed message can be inspected or reprocessed later.
CREATE TABLE IF NOT EXISTS errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_addr   TEXT,                 -- best-effort, may be the envelope sender
  subject     TEXT,                 -- best-effort, may be null if parse failed
  reason      TEXT NOT NULL,        -- 'parse_failed' | 'no_html'
  error       TEXT,                 -- exception message, if any
  raw         TEXT,                 -- raw RFC822 message for later inspection
  received_at INTEGER NOT NULL      -- unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_errors_received_at ON errors (received_at DESC);
