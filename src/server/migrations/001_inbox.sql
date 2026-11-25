-- The teammates and their event inboxes.
--
-- A teammate belongs to one company (its Keycloak organization alias). Its inbox holds every
-- event that should wake it: a new email, a changed file, a timer, a person's answer.

CREATE TABLE teammates (
  company text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('invoice', 'news')),
  name text NOT NULL,
  -- The kill switch. The worker claims nothing for a paused teammate.
  paused boolean NOT NULL DEFAULT false,
  daily_budget_usd numeric(10, 4) NOT NULL DEFAULT 1.00 CHECK (daily_budget_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, id)
);

-- One row per event. The sender's own id (source, source_id) is unique per inbox, so a second
-- delivery of the same event only adds to deliveries.
--
--   queued   waiting, from available_at on
--   claimed  a run holds it until lease_until; a lease that runs out is claimed again
--   done     the run that held it finished
--   dead     it failed on every attempt; a person looks at it
CREATE TABLE inbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  teammate text NOT NULL,
  source text NOT NULL,
  source_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'done', 'dead')),
  deliveries integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid,
  lease_until timestamptz,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (company, teammate) REFERENCES teammates (company, id),
  UNIQUE (company, teammate, source, source_id)
);
CREATE INDEX inbox_events_ready ON inbox_events (company, teammate, received_at) WHERE status IN ('queued', 'claimed');
CREATE INDEX inbox_events_run ON inbox_events (run_id);

-- A new event wakes the worker at once; the worker also polls, so a lost notice only delays.
CREATE FUNCTION inbox_events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('inbox', NEW.company || '/' || NEW.teammate);
  RETURN NEW;
END $$;
CREATE TRIGGER inbox_events_notify AFTER INSERT ON inbox_events FOR EACH ROW EXECUTE FUNCTION inbox_events_notify();
