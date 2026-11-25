-- What people say to a teammate from Mission Control, and what it says back. A person's message
-- and the teammate's reply share message_id, so a message sent twice, or answered twice, is kept once.
CREATE TABLE conversation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  teammate text NOT NULL,
  message_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('person', 'teammate')),
  author text NOT NULL,
  text text NOT NULL,
  run_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company, teammate) REFERENCES teammates (company, id),
  UNIQUE (company, teammate, message_id, role)
);
CREATE INDEX conversation_by_teammate ON conversation (company, teammate, at DESC);
