-- Gmail and Google Drive cannot read their history from the beginning. Their first read starts
-- at the cursor the first watch returned, kept here.
ALTER TABLE subscriptions ADD COLUMN start_cursor text;

-- Gmail takes no idempotency key. The gateway notes each send before it starts and after Gmail
-- accepts it. A key that started and never finished is refused, never sent a second time.
CREATE TABLE gmail_sends (
  idempotency_key text PRIMARY KEY,
  message_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
