-- Paying bills. A bill keeps the bank account it was posted with, so a payment can never go to
-- an account the vendor's record gained later without a person looking at it first.

ALTER TABLE bills ADD COLUMN pay_to_iban text;
UPDATE bills b SET pay_to_iban = v.iban FROM vendors v WHERE v.id = b.vendor_id;
ALTER TABLE bills ALTER COLUMN pay_to_iban SET NOT NULL;
ALTER TABLE bills ADD COLUMN paid_at timestamptz;
ALTER TABLE bills ADD COLUMN paid_by text;

-- Two bills that fall due this week. Their dates move with the day the books start, so a fresh
-- setup always has a pay run to make. Pixelforge's October licence above is overdue and is paid too.
INSERT INTO bills (id, vendor_id, invoice_number, invoice_date, due_date, currency, net, tax, total, posted_by, posted_because, source, pay_to_iban)
  VALUES ('3a1c9e7b-5d2f-4b8a-9c6e-1f0d2b4a6c02', 'V-004', 'HL-2026-11', current_date - 20, current_date + 2, 'EUR', 1250.00, 250.00, 1500.00, 'ada@bramble.example', 'entered by hand', 'paper invoice', 'IE29AIBK93115212345678');
INSERT INTO bill_lines (bill_id, position, description, amount)
  VALUES ('3a1c9e7b-5d2f-4b8a-9c6e-1f0d2b4a6c02', 1, 'Studio rent, November', 1250.00);
INSERT INTO journal_entries (id, bill_id, entry_date, memo)
  VALUES ('8d2f3e4a-5b6c-4d7e-9f0a-1b2c3d4e5f02', '3a1c9e7b-5d2f-4b8a-9c6e-1f0d2b4a6c02', current_date - 20, 'Harbor Lane Studios HL-2026-11');
INSERT INTO journal_lines (entry_id, position, account, debit, credit) VALUES
  ('8d2f3e4a-5b6c-4d7e-9f0a-1b2c3d4e5f02', 1, '6300', 1250.00, 0),
  ('8d2f3e4a-5b6c-4d7e-9f0a-1b2c3d4e5f02', 2, '1300', 250.00, 0),
  ('8d2f3e4a-5b6c-4d7e-9f0a-1b2c3d4e5f02', 3, '2000', 0, 1500.00);

-- Copperleaf's bank changed after this bill posted. The bill still names the old account, so
-- it must never be paid until a person calls Copperleaf and posts it again.
INSERT INTO bills (id, vendor_id, invoice_number, invoice_date, due_date, currency, net, tax, total, posted_by, posted_because, source, pay_to_iban)
  VALUES ('4b2d0f8c-6e3a-4c9b-8d7f-2a1e3c5b7d03', 'V-005', 'CC-5480', current_date - 12, current_date + 3, 'EUR', 350.00, 70.00, 420.00, 'ada@bramble.example', 'entered by hand', 'paper invoice', 'ES7620770024003102575766');
INSERT INTO bill_lines (bill_id, position, description, amount)
  VALUES ('4b2d0f8c-6e3a-4c9b-8d7f-2a1e3c5b7d03', 1, 'Lunch for the client workshop', 350.00);
INSERT INTO journal_entries (id, bill_id, entry_date, memo)
  VALUES ('9e3a4f5b-6c7d-4e8f-8a1b-2c3d4e5f6a03', '4b2d0f8c-6e3a-4c9b-8d7f-2a1e3c5b7d03', current_date - 12, 'Copperleaf Catering CC-5480');
INSERT INTO journal_lines (entry_id, position, account, debit, credit) VALUES
  ('9e3a4f5b-6c7d-4e8f-8a1b-2c3d4e5f6a03', 1, '6400', 350.00, 0),
  ('9e3a4f5b-6c7d-4e8f-8a1b-2c3d4e5f6a03', 2, '1300', 70.00, 0),
  ('9e3a4f5b-6c7d-4e8f-8a1b-2c3d4e5f6a03', 3, '2000', 0, 420.00);
INSERT INTO audit_log (actor, action, subject, detail)
  VALUES ('ada@bramble.example', 'vendor.bank_changed', 'V-005', '{"from": "ES7620770024003102575766", "to": "ES9121000418450200051332"}');
