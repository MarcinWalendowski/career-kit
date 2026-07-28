-- career.db - the job application tracker.
--
-- Two kinds of column live in `applications`:
--   MACHINE-OWNED  rebuilt from jobs/*.json on every `db.mjs` run.
--   HUMAN-OWNED    typed by a person (or by an agent on their behalf) and NEVER
--                  overwritten by a rebuild. Stage, priority, salary
--                  expectation, next action, human notes.
-- The rebuild is an upsert, never a DELETE, so anything typed here survives.
-- The authoritative list of machine columns is MACHINE_COLS in db.mjs; this
-- file's job is to make the two kinds visibly separate to anyone reading it.
--
-- Four fixes carried in from the audit of the tracker this schema comes from:
--
--   1. `applications.id` is no longer forced equal to `company_id`. That was an
--      invariant in the builder, and it made re-applying to a company next year
--      a primary-key collision. One-contact-per-company is a GATE POLICY
--      (rules.yaml company.maxApplications / cooldownDays), which is a thing a
--      user can change; a primary key is not.
--   2. Posted compensation comes from the job record, written by the adapter
--      that actually read the posting. It used to come from a dict of literals
--      hardcoded in the build script, one entry per application.
--   3. `receipt` and `needs_human` exist, because a form submit leaves no Sent
--      folder and a record with no proof behind it has to be visible as such.
--   4. One `stage` list. It had eleven values in one file and nine in another,
--      and the two files disagreed about which nine. It is now a CHECK
--      constraint, so the database rejects a twelfth instead of storing it.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id        TEXT PRIMARY KEY,           -- job record's company_id
  name      TEXT NOT NULL,
  domains   TEXT,                       -- comma separated
  website   TEXT,
  notes     TEXT                        -- human-owned
);

CREATE TABLE IF NOT EXISTS applications (
  id          TEXT PRIMARY KEY,         -- job record's id: <company>-<role-slug>[-<n>]
  company_id  TEXT NOT NULL REFERENCES companies(id),

  -- machine-owned: what we sent, how, where
  role        TEXT,
  channel     TEXT,                     -- the apply.channel enum, enforced by validate.mjs
  target      TEXT,                     -- address or form URL
  send_status TEXT,                     -- the job record's status enum
  sent_at     TEXT,                     -- ISO 8601 instant, transport-derived
  sent_at_source TEXT,                  -- transport | NULL. Never a client clock.
  message_id  TEXT,                     -- RFC822 Message-ID for email sends
  subject     TEXT,
  receipt     TEXT,                     -- path under outputs/receipts/<id>/
  needs_human INTEGER NOT NULL DEFAULT 0,   -- sent, but nothing proves it
  duplicate_submission INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,                     -- the job record's notes field

  -- machine-owned: provenance
  source          TEXT,                 -- adapter id
  url             TEXT,
  route_confidence REAL,
  identity_domain TEXT,
  identity_verified INTEGER NOT NULL DEFAULT 0,
  discovered_at   TEXT,

  -- machine-owned: posted terms, read off the posting by the adapter
  location        TEXT,
  workplace_type  TEXT,                 -- onsite | hybrid | remote | unknown
  comp_currency   TEXT,
  comp_min        INTEGER,
  comp_max        INTEGER,
  comp_period     TEXT DEFAULT 'year',
  equity          TEXT,

  -- machine-owned: reconciliation. Set when the jobs/<id>.json behind this row
  -- has disappeared. The row is kept and flagged, never silently dropped: a
  -- deleted job file is usually a mistake, and a row that vanishes with it
  -- takes the send history with it.
  orphaned        INTEGER NOT NULL DEFAULT 0,

  -- HUMAN-OWNED from here down. A rebuild will not touch these.
  stage           TEXT NOT NULL DEFAULT 'applied'
                  CHECK (stage IN ('discovered', 'draft', 'applied', 'replied', 'screening',
                                   'interview', 'offer', 'rejected', 'withdrawn',
                                   'closed', 'no_response', 'no_route')),
  priority        INTEGER,              -- 1 = chase hardest
  expect_currency TEXT,
  expect_min      INTEGER,
  expect_max      INTEGER,
  expect_notes    TEXT,
  next_action     TEXT,
  next_action_due TEXT,                 -- ISO date
  human_notes     TEXT,

  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT REFERENCES companies(id),
  name       TEXT,
  email      TEXT,
  role       TEXT,
  source     TEXT,
  UNIQUE (company_id, email)
);

-- Every touch in either direction. Reply tracking hangs off this.
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL REFERENCES applications(id),
  ts             TEXT NOT NULL,         -- ISO 8601 instant
  direction      TEXT NOT NULL,         -- out | in
  channel        TEXT,
  summary        TEXT,
  message_id     TEXT,
  body           TEXT
);

-- An expression in a UNIQUE constraint is illegal inline and legal as an index.
-- This is what makes the rebuild's event insert idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
  ON events (application_id, ts, direction, COALESCE(message_id, ''));

CREATE INDEX IF NOT EXISTS idx_events_app ON events (application_id, ts);
CREATE INDEX IF NOT EXISTS idx_apps_stage ON applications (stage);
CREATE INDEX IF NOT EXISTS idx_apps_company ON applications (company_id);

-- The everyday table: one row per application, newest activity first.
CREATE VIEW IF NOT EXISTS v_pipeline AS
SELECT
  a.id,
  c.name                                   AS company,
  a.role,
  a.channel,
  a.target,
  a.send_status,
  substr(a.sent_at, 1, 16)                 AS sent,
  a.stage,
  CASE WHEN a.comp_min IS NULL THEN NULL
       ELSE a.comp_currency || ' ' || (a.comp_min / 1000) || 'k-' || (a.comp_max / 1000) || 'k'
  END                                      AS posted_comp,
  CASE WHEN a.expect_min IS NULL THEN NULL
       ELSE a.expect_currency || ' ' || (a.expect_min / 1000) || 'k-' || (a.expect_max / 1000) || 'k'
  END                                      AS my_expectation,
  a.location,
  a.workplace_type,
  a.receipt,
  a.needs_human,
  a.orphaned,
  (SELECT COUNT(*) FROM events e WHERE e.application_id = a.id AND e.direction = 'in')  AS replies,
  (SELECT MAX(e.ts) FROM events e WHERE e.application_id = a.id)                        AS last_touch,
  a.next_action,
  a.next_action_due
FROM applications a
JOIN companies c ON c.id = a.company_id
ORDER BY a.send_status DESC, a.sent_at DESC;

-- They wrote back and we have not answered yet.
CREATE VIEW IF NOT EXISTS v_needs_reply AS
SELECT
  a.id,
  c.name AS company,
  a.role,
  a.stage,
  last_in.ts      AS their_last_message,
  last_in.summary AS what_they_said
FROM applications a
JOIN companies c ON c.id = a.company_id
JOIN (SELECT application_id, MAX(ts) AS ts, summary
        FROM events WHERE direction = 'in' GROUP BY application_id) last_in
  ON last_in.application_id = a.id
LEFT JOIN (SELECT application_id, MAX(ts) AS ts
             FROM events WHERE direction = 'out' GROUP BY application_id) last_out
  ON last_out.application_id = a.id
WHERE last_out.ts IS NULL OR last_out.ts < last_in.ts
ORDER BY last_in.ts DESC;

-- Where we never got a route out.
CREATE VIEW IF NOT EXISTS v_unsent AS
SELECT a.id, c.name AS company, a.role, a.send_status, a.notes
FROM applications a JOIN companies c ON c.id = a.company_id
WHERE a.send_status NOT IN ('sent', 'sent-unverified');
