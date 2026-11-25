-- QuirkBooks: Bramble Studio's books. Double entry: every bill posts a journal entry whose
-- debits equal its credits, and every write lands in the audit log.

CREATE TABLE accounts (
  code text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('asset', 'liability', 'expense'))
);

CREATE TABLE vendors (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  iban text NOT NULL,
  currency text NOT NULL,
  requires_po boolean NOT NULL DEFAULT false,
  -- Where a bill from this vendor is booked when nobody says otherwise.
  expense_account text NOT NULL REFERENCES accounts (code)
);

CREATE TABLE purchase_orders (
  number text PRIMARY KEY,
  vendor_id text NOT NULL REFERENCES vendors (id),
  amount numeric(12, 2) NOT NULL,
  currency text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  description text NOT NULL
);

CREATE TABLE bills (
  id uuid PRIMARY KEY,
  vendor_id text NOT NULL REFERENCES vendors (id),
  invoice_number text NOT NULL,
  invoice_date date NOT NULL,
  due_date date,
  po_number text REFERENCES purchase_orders (number),
  currency text NOT NULL,
  net numeric(12, 2) NOT NULL,
  tax numeric(12, 2) NOT NULL,
  total numeric(12, 2) NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid')),
  -- Who posted it: a person's email or a program's key name.
  posted_by text NOT NULL,
  -- Why it posted: the checks passed, or a person approved it.
  posted_because text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, invoice_number)
);

CREATE TABLE bill_lines (
  bill_id uuid NOT NULL REFERENCES bills (id),
  position integer NOT NULL,
  description text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  PRIMARY KEY (bill_id, position)
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY,
  bill_id uuid REFERENCES bills (id),
  entry_date date NOT NULL,
  memo text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  entry_id uuid NOT NULL REFERENCES journal_entries (id),
  position integer NOT NULL,
  account text NOT NULL REFERENCES accounts (code),
  debit numeric(12, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(12, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  PRIMARY KEY (entry_id, position)
);

-- A write sent twice with the same key is done once; the second gets the first's answer.
CREATE TABLE idempotency (
  client text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, key)
);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  subject text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (id text PRIMARY KEY, subject text NOT NULL, tokens jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sign_ins (state text PRIMARY KEY, code_verifier text NOT NULL, nonce text NOT NULL, return_to text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

INSERT INTO accounts (code, name, kind) VALUES
  ('1000', 'Bank', 'asset'),
  ('1300', 'VAT receivable', 'asset'),
  ('2000', 'Accounts payable', 'liability'),
  ('6000', 'Office supplies', 'expense'),
  ('6100', 'Software', 'expense'),
  ('6200', 'Contractors', 'expense'),
  ('6300', 'Rent', 'expense'),
  ('6400', 'Catering', 'expense'),
  ('6500', 'Printing', 'expense');

INSERT INTO vendors (id, name, email, iban, currency, requires_po, expense_account) VALUES
  ('V-001', 'Northwind Paper Co.', 'billing@northwind.example', 'DE89370400440532013000', 'EUR', true, '6000'),
  ('V-002', 'Pixelforge Software', 'accounts@pixelforge.example', 'NL91ABNA0417164300', 'EUR', false, '6100'),
  ('V-003', 'Kestrel Freelance', 'invoices@kestrel.example', 'FR1420041010050500013M02606', 'EUR', false, '6200'),
  ('V-004', 'Harbor Lane Studios', 'rent@harborlane.example', 'IE29AIBK93115212345678', 'EUR', false, '6300'),
  ('V-005', 'Copperleaf Catering', 'hello@copperleaf.example', 'ES9121000418450200051332', 'EUR', false, '6400'),
  ('V-006', 'Lumen Print House', 'billing@lumen.example', 'BE68539007547034', 'EUR', true, '6500');

INSERT INTO purchase_orders (number, vendor_id, amount, currency, status, description) VALUES
  ('PO-1042', 'V-001', 1000.00, 'EUR', 'open', 'Recycled paper for the autumn catalogue'),
  ('PO-1043', 'V-006', 1800.00, 'EUR', 'open', 'Printing of 500 brand books'),
  ('PO-1031', 'V-001', 400.00, 'EUR', 'closed', 'Envelopes, delivered in October');

-- Pixelforge's October licence is already in the books, so its resend is a duplicate.
INSERT INTO bills (id, vendor_id, invoice_number, invoice_date, due_date, currency, net, tax, total, posted_by, posted_because, source)
  VALUES ('5b7f0c2e-9d1a-4e3b-8c6f-2a4d1e7b9c01', 'V-002', 'PF-8812', '2026-10-01', '2026-10-31', 'EUR', 490.00, 98.00, 588.00, 'ada@bramble.example', 'entered by hand', 'paper invoice');
INSERT INTO bill_lines (bill_id, position, description, amount)
  VALUES ('5b7f0c2e-9d1a-4e3b-8c6f-2a4d1e7b9c01', 1, 'Design suite licence, October', 490.00);
INSERT INTO journal_entries (id, bill_id, entry_date, memo)
  VALUES ('7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', '5b7f0c2e-9d1a-4e3b-8c6f-2a4d1e7b9c01', '2026-10-01', 'Pixelforge Software PF-8812');
INSERT INTO journal_lines (entry_id, position, account, debit, credit) VALUES
  ('7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', 1, '6100', 490.00, 0),
  ('7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', 2, '1300', 98.00, 0),
  ('7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', 3, '2000', 0, 588.00);
