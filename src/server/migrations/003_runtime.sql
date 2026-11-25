-- What the worker and gateway need beyond the core tables: the teammates themselves, where
-- each one stopped reading its sources, and which approvals have been carried out.

-- Above this total a bill waits for a person, even when every check passes.
ALTER TABLE teammates ADD COLUMN auto_post_limit numeric(14, 2) NOT NULL DEFAULT 2000 CHECK (auto_post_limit >= 0);

-- Bramble Studio's two teammates. Both start quiet: what they write outside waits as a draft.
INSERT INTO teammates (company, id, kind, name, daily_budget_usd) VALUES
  ('bramble', 'invoices', 'invoice', 'Invoice teammate', 1.00),
  ('bramble', 'news', 'news', 'News teammate', 0.50)
ON CONFLICT DO NOTHING;

-- Where a teammate stopped reading a source: LMail's history id, LDrive's page token.
-- It moves forward only after the run that read up to it has finished.
CREATE TABLE cursors (
  company text NOT NULL,
  teammate text NOT NULL,
  source text NOT NULL,
  position text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, teammate, source),
  FOREIGN KEY (company, teammate) REFERENCES teammates (company, id)
);

-- The channels Mission Control holds open on the world apps, renewed before they run out.
CREATE TABLE subscriptions (
  source text PRIMARY KEY,
  channel_id text,
  token text,
  expires_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL DEFAULT now()
);

-- An approval is carried out once. A checks-failed approval never offers "allow always":
-- a failed check is a fact about one invoice, not a standing rule.
ALTER TABLE approvals ADD COLUMN executed_at timestamptz;
ALTER TABLE approvals ADD COLUMN can_allow_always boolean NOT NULL DEFAULT false;
CREATE INDEX approvals_thread ON approvals (thread_id, created_at DESC);

-- A run's batch and the threads it worked, so the board can link a card to its run.
ALTER TABLE runs ADD COLUMN threads text[] NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN trace_id text;
