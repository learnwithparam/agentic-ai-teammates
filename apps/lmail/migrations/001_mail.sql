-- LMail: mailboxes for the domains it hosts, the messages in them, and who watches them.

-- Mail for these domains is kept here; mail for any other domain needs the relay.
CREATE TABLE domains (name text PRIMARY KEY);

CREATE TABLE mailboxes (
  address text PRIMARY KEY,
  display_name text NOT NULL,
  -- Grows by one with every change, like Gmail's historyId.
  history_id bigint NOT NULL DEFAULT 1
);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  mailbox text NOT NULL REFERENCES mailboxes (address),
  folder text NOT NULL CHECK (folder IN ('inbox', 'sent')),
  message_id text NOT NULL,
  in_reply_to text,
  from_address text NOT NULL,
  from_name text,
  to_addresses text[] NOT NULL,
  subject text NOT NULL DEFAULT '',
  text_body text NOT NULL DEFAULT '',
  html_body text,
  history_id bigint NOT NULL,
  unread boolean NOT NULL DEFAULT true,
  -- A send with the same key from the same mailbox is sent once.
  idempotency_key text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox, idempotency_key)
);
CREATE INDEX messages_folder ON messages (mailbox, folder, received_at DESC);
CREATE INDEX messages_history ON messages (mailbox, history_id);

CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages (id),
  filename text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  content bytea NOT NULL
);
CREATE INDEX attachments_message ON attachments (message_id);

-- A program that wants to hear about new mail, like Gmail's users.watch. It runs out after
-- seven days unless the watcher renews it.
CREATE TABLE watches (
  mailbox text NOT NULL REFERENCES mailboxes (address),
  url text NOT NULL,
  client text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (mailbox, url)
);

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,
  url text NOT NULL,
  type text NOT NULL,
  body jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_at) WHERE status = 'waiting';

CREATE TABLE sessions (id text PRIMARY KEY, subject text NOT NULL, tokens jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sign_ins (state text PRIMARY KEY, code_verifier text NOT NULL, nonce text NOT NULL, return_to text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- Bramble Studio's mail and the vendors it buys from. Each vendor's billing address is here so
-- their invoices, and Bramble's replies, travel as real mail you can open.
INSERT INTO domains (name) VALUES
  ('bramble.example'), ('northwind.example'), ('pixelforge.example'), ('kestrel.example'),
  ('harborlane.example'), ('copperleaf.example'), ('lumen.example');
INSERT INTO mailboxes (address, display_name) VALUES
  ('ap@bramble.example', 'Bramble accounts payable'),
  ('ada@bramble.example', 'Ada Okafor'),
  ('ravi@bramble.example', 'Ravi Menon'),
  ('mei@bramble.example', 'Mei Tanaka'),
  ('billing@northwind.example', 'Northwind Paper Co.'),
  ('accounts@pixelforge.example', 'Pixelforge Software'),
  ('invoices@kestrel.example', 'Kestrel Freelance'),
  ('rent@harborlane.example', 'Harbor Lane Studios'),
  ('hello@copperleaf.example', 'Copperleaf Catering'),
  ('billing@lumen.example', 'Lumen Print House');
