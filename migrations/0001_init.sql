CREATE TABLE receipts (
  id TEXT PRIMARY KEY, message_id TEXT UNIQUE, received_at TEXT NOT NULL, email_date TEXT,
  sender TEXT, subject TEXT, body TEXT, body_is_html INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, reason TEXT,
  supplier TEXT, total_minor INTEGER, currency TEXT, receipt_date TEXT,
  confidence REAL, input_kind TEXT,
  pinned_line TEXT, pinned_by TEXT, explanation_url TEXT, attachment_urls TEXT,
  attach_claimed_at TEXT, duplicate_of TEXT, notified TEXT NOT NULL DEFAULT '[]',
  filed_at TEXT, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX receipts_pinned_line ON receipts(pinned_line) WHERE pinned_line IS NOT NULL;
CREATE TABLE files (id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, r2_key TEXT NOT NULL,
  filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL);
CREATE INDEX files_sha256 ON files(sha256);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id TEXT NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE rates (day TEXT NOT NULL, currency TEXT NOT NULL, to_gbp REAL NOT NULL, PRIMARY KEY (day, currency));
