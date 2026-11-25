-- LDrive: folders, the files in them (their bytes are in S3), and a change log watchers read.

CREATE TABLE folders (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id uuid PRIMARY KEY,
  folder_id uuid NOT NULL REFERENCES folders (id),
  name text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  sha256 text NOT NULL,
  object_key text NOT NULL,
  uploaded_by text NOT NULL,
  trashed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_folder ON files (folder_id, created_at DESC);

-- Every add or removal, in order. A watcher keeps the id of the last change it read, like the
-- page token of Google Drive's changes.list, and asks for what came after.
CREATE TABLE changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES files (id),
  kind text NOT NULL CHECK (kind IN ('added', 'removed')),
  at timestamptz NOT NULL DEFAULT now()
);

-- A program that wants to hear about changes, like Drive's changes.watch. The token comes back
-- on every notice so the watcher can tell its own channel; a channel runs out and is renewed.
CREATE TABLE channels (
  id uuid PRIMARY KEY,
  address text NOT NULL,
  token text NOT NULL,
  client text NOT NULL,
  expires_at timestamptz NOT NULL,
  message_number bigint NOT NULL DEFAULT 0
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

INSERT INTO folders (id, name) VALUES
  ('6f1c2b1e-4a51-4f7e-9b0e-0d3c1a7e2f10', 'Invoices'),
  ('0a9e7d55-21c4-4c63-8f2e-5b6a4d3c2e11', 'Contracts');
