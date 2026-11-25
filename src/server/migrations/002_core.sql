-- Runs, spend, permissions, timers, the outbox, people's sessions and the audit log.

-- Quiet mode: a teammate's outside messages wait as drafts until a person sends them.
ALTER TABLE teammates ADD COLUMN quiet boolean NOT NULL DEFAULT true;

-- One row per run: one claimed batch of inbox events, worked to a stop reason.
CREATE TABLE runs (
  id uuid PRIMARY KEY,
  company text NOT NULL,
  teammate text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished')),
  stop_reason text CHECK (stop_reason IN ('sent', 'nothing_to_send', 'deferred', 'handed_to_human', 'failed')),
  summary text,
  steps integer NOT NULL DEFAULT 0,
  tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (company, teammate) REFERENCES teammates (company, id)
);
CREATE INDEX runs_recent ON runs (company, teammate, started_at DESC);

-- The run's timeline: each routing choice, model call, tool call and check, in order.
-- The run drawer shows it; detail never holds a model name or a secret.
CREATE TABLE run_steps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs (id),
  kind text NOT NULL CHECK (kind IN ('route', 'model', 'tool', 'check', 'note')),
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_steps_run ON run_steps (run_id, id);

-- What each model call cost, from OpenRouter's usage.cost. The gateway writes it and checks a
-- teammate's daily budget against it before the next call.
CREATE TABLE spend (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  teammate text NOT NULL,
  run_id uuid,
  tier text NOT NULL CHECK (tier IN ('fast', 'strong')),
  task text NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  cost_usd numeric(12, 6) NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spend_day ON spend (company, teammate, at);

-- A person's standing answer for one tool: allow it, let the quick model judge it, or ask.
-- "Allow always" on an approval writes a row here.
CREATE TABLE tool_rules (
  company text NOT NULL,
  teammate text NOT NULL,
  tool text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow', 'classify', 'approve')),
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, teammate, tool)
);

-- One action a teammate asked a person to decide. payload_hash pins the exact action: the
-- gateway only acts on an approval whose hash matches what it is about to do.
CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  company text NOT NULL,
  teammate text NOT NULL,
  run_id uuid NOT NULL,
  thread_id text NOT NULL,
  tool text NOT NULL,
  args jsonb NOT NULL,
  payload_hash text NOT NULL,
  amount numeric(14, 2),
  currency text,
  title text NOT NULL,
  brief text NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by text,
  decided_by_name text,
  decision_note text,
  allow_always boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX approvals_open ON approvals (company, status, created_at);

-- Follow-ups and schedules. The scheduler writes a due timer to the inbox and never starts a run.
CREATE TABLE timers (
  id uuid PRIMARY KEY,
  company text NOT NULL,
  teammate text NOT NULL,
  name text NOT NULL,
  -- A cron timer repeats; a once timer fires one time.
  cron text,
  fire_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'fired', 'cancelled')),
  last_fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company, teammate) REFERENCES teammates (company, id),
  UNIQUE (company, teammate, name)
);
CREATE INDEX timers_due ON timers (fire_at) WHERE status = 'waiting';

-- Messages leaving the company. The dispatcher sends them, paced per target, with retries.
--   draft    quiet mode: a person sends it, or discards it
--   queued   waiting for the dispatcher, from available_at on
--   sending  a dispatcher holds it until lease_until
--   sent, discarded, dead
CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  company text NOT NULL,
  teammate text NOT NULL,
  run_id uuid,
  target text NOT NULL CHECK (target IN ('lmail.send', 'github.publish')),
  title text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'discarded', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  error text,
  result jsonb,
  released_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX outbox_ready ON outbox (target, available_at) WHERE status IN ('queued', 'sending');

-- The last send per target, so the dispatcher paces each target on its own.
CREATE TABLE outbox_pacing (
  target text PRIMARY KEY,
  last_sent_at timestamptz NOT NULL
);

-- A person's chat with a teammate, from the run drawer. Long threads are compacted: older
-- messages fold into the summary row.
CREATE TABLE chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  teammate text NOT NULL,
  role text NOT NULL CHECK (role IN ('person', 'teammate', 'summary')),
  author text,
  content text NOT NULL,
  folded boolean NOT NULL DEFAULT false,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_thread ON chat_messages (company, teammate, id);

-- Signed-in people. The cookie holds only the id; tokens never reach the browser.
CREATE TABLE sessions (
  id text PRIMARY KEY,
  subject text NOT NULL,
  tokens jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sign-in attempts between the redirect to Keycloak and the callback.
CREATE TABLE sign_ins (
  state text PRIMARY KEY,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- News cards already published, so a story never repeats within a week.
CREATE TABLE news_published (
  company text NOT NULL,
  url text NOT NULL,
  day date NOT NULL,
  headline text NOT NULL,
  PRIMARY KEY (company, url)
);

-- Every decision a person or a teammate makes that changes something outside.
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  subject text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_recent ON audit_log (company, at DESC);
