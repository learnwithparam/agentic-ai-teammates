-- A schedule's times are in a place's time zone, so "7 every morning" stays 7 across a clock change.
ALTER TABLE timers ADD COLUMN timezone text;
ALTER TABLE timers ADD CONSTRAINT timers_cron_has_zone CHECK ((cron IS NULL) = (timezone IS NULL));

-- The people who have signed in, with the roles their last sign-in carried. Keycloak stays the
-- source of truth; this copy lets a reminder reach the people who can decide.
CREATE TABLE members (
  company text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  roles text[] NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, subject)
);
