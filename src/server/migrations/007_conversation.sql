-- What one person and one teammate say to each other. Each thread is private to its person,
-- because an answer may quote what only that person was allowed to look up.
CREATE TABLE conversation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  teammate text NOT NULL,
  person text NOT NULL,
  message_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('person', 'teammate')),
  author text NOT NULL,
  text text NOT NULL,
  run_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company, teammate) REFERENCES teammates (company, id),
  UNIQUE (company, teammate, person, message_id, role)
);
CREATE INDEX conversation_by_person ON conversation (company, teammate, person, at DESC);
