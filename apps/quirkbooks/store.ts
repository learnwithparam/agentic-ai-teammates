import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { inTransaction } from "../../src/server/db";
import { HttpError } from "../shared/server";

// Bramble Studio's books. A bill posts as one journal entry: the expense and the VAT on the
// debit side, what is owed to the vendor on the credit side. The two sides always balance.

const CENT = 0.005;
const money = (value: unknown) => Number(value);

const Line = z.object({ description: z.string().min(1), amount: z.number() });

export const NewBill = z.object({
  vendorId: z.string().min(1),
  invoiceNumber: z.string().min(1).max(100),
  invoiceDate: z.iso.date(),
  dueDate: z.iso.date().nullable(),
  poNumber: z.string().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(Line).min(1).max(100),
  tax: z.number().min(0),
  total: z.number().positive(),
  // A sentence a person can read later: "every check passed" or "approved by ravi@...".
  postedBecause: z.string().min(1).max(500),
  source: z.string().max(500).nullable(),
});
export type NewBill = z.infer<typeof NewBill>;

export type Vendor = { id: string; name: string; email: string; iban: string; currency: string; requiresPo: boolean; expenseAccount: string };

export class Books {
  constructor(private readonly pool: Pool) {}

  async vendors(search?: string): Promise<Vendor[]> {
    const term = search?.trim().toLowerCase();
    const { rows } = term
      ? await this.pool.query("SELECT * FROM vendors WHERE lower(name) = $1 OR lower(email) = $1 OR lower(split_part(email, '@', 2)) = split_part($1, '@', 2) ORDER BY name", [term])
      : await this.pool.query("SELECT * FROM vendors ORDER BY name");
    return rows.map(vendor);
  }

  async vendor(id: string): Promise<Vendor | null> {
    const { rows } = await this.pool.query("SELECT * FROM vendors WHERE id = $1", [id]);
    return rows[0] ? vendor(rows[0]) : null;
  }

  async changeBank(id: string, iban: string, actor: string) {
    await inTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ iban: string }>("SELECT iban FROM vendors WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw new HttpError(404, "No such vendor.");
      const plain = iban.replace(/\s+/g, "").toUpperCase();
      await client.query("UPDATE vendors SET iban = $2 WHERE id = $1", [id, plain]);
      await audit(client, actor, "vendor.bank_changed", id, { from: rows[0].iban, to: plain });
    });
  }

  async purchaseOrders() {
    const { rows } = await this.pool.query("SELECT p.*, v.name AS vendor FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id ORDER BY p.number");
    return rows.map(purchaseOrder);
  }

  async purchaseOrder(number: string) {
    const { rows } = await this.pool.query("SELECT p.*, v.name AS vendor FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id WHERE p.number = $1", [number]);
    return rows[0] ? purchaseOrder(rows[0]) : null;
  }

  // dueBy lists only the open bills due on or before that day, overdue ones included, soonest first.
  async bills(filter: { vendorId?: string; invoiceNumber?: string; dueBy?: string } = {}) {
    const { rows } = await this.pool.query(
      `SELECT b.*, v.name AS vendor, v.iban AS vendor_iban FROM bills b JOIN vendors v ON v.id = b.vendor_id
       WHERE ($1::text IS NULL OR b.vendor_id = $1) AND ($2::text IS NULL OR lower(b.invoice_number) = lower($2))
         AND ($3::date IS NULL OR (b.status = 'open' AND b.due_date <= $3))
       ORDER BY CASE WHEN $3::date IS NULL THEN NULL ELSE b.due_date END, b.created_at DESC LIMIT 200`,
      [filter.vendorId ?? null, filter.invoiceNumber ?? null, filter.dueBy ?? null],
    );
    return rows.map(bill);
  }

  async bill(id: string) {
    const { rows } = await this.pool.query(
      "SELECT b.*, v.name AS vendor, v.iban AS vendor_iban FROM bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1",
      [id],
    );
    return rows[0] ? bill(rows[0]) : null;
  }

  async billLines(id: string) {
    const { rows } = await this.pool.query("SELECT position, description, amount FROM bill_lines WHERE bill_id = $1 ORDER BY position", [id]);
    return rows.map((row) => ({ position: row.position, description: row.description, amount: money(row.amount) }));
  }

  async journal() {
    const { rows } = await this.pool.query(
      `SELECT e.id, e.entry_date, e.memo, l.position, l.account, a.name AS account_name, l.debit, l.credit
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.code = l.account
       ORDER BY e.created_at DESC, l.position LIMIT 600`,
    );
    return rows.map((row) => ({
      entryId: row.id, date: dateText(row.entry_date), memo: row.memo, account: row.account,
      accountName: row.account_name, debit: money(row.debit), credit: money(row.credit),
    }));
  }

  async auditLog() {
    const { rows } = await this.pool.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200");
    return rows.map((row) => ({ id: String(row.id), actor: row.actor, action: row.action, subject: row.subject, detail: row.detail, at: row.at.toISOString() }));
  }

  // Posts a bill once per idempotency key. The same key with a different bill is refused, so a
  // retry can never post something other than what was first sent.
  async postBill(input: NewBill, actor: string, idempotencyKey: string): Promise<{ status: number; body: unknown }> {
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${actor}:${idempotencyKey}`]);
      const seen = await client.query<{ request_hash: string; status: number; response: unknown }>(
        "SELECT request_hash, status, response FROM idempotency WHERE client = $1 AND key = $2",
        [actor, idempotencyKey],
      );
      if (seen.rows[0]) {
        if (seen.rows[0].request_hash !== requestHash) throw new HttpError(422, "This Idempotency-Key was used for a different bill.");
        return { status: seen.rows[0].status, body: seen.rows[0].response };
      }
      const result = await this.insertBill(client, input, actor);
      await client.query("INSERT INTO idempotency (client, key, request_hash, status, response) VALUES ($1, $2, $3, $4, $5)", [
        actor, idempotencyKey, requestHash, result.status, JSON.stringify(result.body),
      ]);
      return result;
    });
  }

  private async insertBill(client: PoolClient, input: NewBill, actor: string): Promise<{ status: number; body: unknown }> {
    const { rows: vendors } = await client.query("SELECT * FROM vendors WHERE id = $1", [input.vendorId]);
    if (!vendors[0]) return { status: 404, body: { error: "No such vendor." } };
    const supplier = vendor(vendors[0]);
    const net = input.lines.reduce((sum, line) => sum + line.amount, 0);
    if (Math.abs(net + input.tax - input.total) > CENT) return { status: 422, body: { error: "The lines and tax do not add up to the total." } };
    if (input.currency !== supplier.currency) return { status: 422, body: { error: `${supplier.name} bills in ${supplier.currency}.` } };
    if (input.poNumber) {
      const { rows } = await client.query("SELECT vendor_id FROM purchase_orders WHERE number = $1", [input.poNumber]);
      if (rows[0]?.vendor_id !== supplier.id) return { status: 422, body: { error: `${input.poNumber} is not a purchase order of ${supplier.name}.` } };
    }
    const { rows: existing } = await client.query<{ id: string }>(
      "SELECT id FROM bills WHERE vendor_id = $1 AND lower(invoice_number) = lower($2)",
      [supplier.id, input.invoiceNumber],
    );
    if (existing[0]) return { status: 409, body: { error: "This invoice is already in the books.", billId: existing[0].id } };
    const id = randomUUID();
    await client.query(
      `INSERT INTO bills (id, vendor_id, invoice_number, invoice_date, due_date, po_number, currency, net, tax, total, posted_by, posted_because, source, pay_to_iban)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, supplier.id, input.invoiceNumber, input.invoiceDate, input.dueDate, input.poNumber, input.currency, round(net), input.tax, input.total, actor, input.postedBecause, input.source, supplier.iban],
    );
    for (const [index, line] of input.lines.entries()) {
      await client.query("INSERT INTO bill_lines (bill_id, position, description, amount) VALUES ($1, $2, $3, $4)", [id, index + 1, line.description, line.amount]);
    }
    const entryId = randomUUID();
    await client.query("INSERT INTO journal_entries (id, bill_id, entry_date, memo) VALUES ($1, $2, $3, $4)", [
      entryId, id, input.invoiceDate, `${supplier.name} ${input.invoiceNumber}`,
    ]);
    const lines: [string, number, number][] = [[supplier.expenseAccount, round(net), 0], ["2000", 0, input.total]];
    if (input.tax > 0) lines.splice(1, 0, ["1300", input.tax, 0]);
    for (const [index, [account, debit, credit]] of lines.entries()) {
      await client.query("INSERT INTO journal_lines (entry_id, position, account, debit, credit) VALUES ($1, $2, $3, $4, $5)", [entryId, index + 1, account, debit, credit]);
    }
    await audit(client, actor, "bill.posted", id, { vendor: supplier.id, invoiceNumber: input.invoiceNumber, total: input.total, because: input.postedBecause });
    return { status: 201, body: { id, vendorId: supplier.id, invoiceNumber: input.invoiceNumber, total: input.total } };
  }

  // A person pays a bill from the web page.
  async markPaid(id: string, actor: string) {
    await inTransaction(this.pool, async (client) => {
      const found = await lockBill(client, id);
      if (!found) throw new HttpError(404, "No such bill.");
      if (found.status === "paid") return;
      await pay(client, found, actor, "paid by hand");
    });
  }

  // A program pays a bill once per idempotency key. QuirkBooks itself refuses a bill that is
  // paid already, and one whose vendor's bank changed after the bill was posted: the money
  // would go to an account nobody checked against the invoice.
  async payBill(id: string, because: string, actor: string, idempotencyKey: string): Promise<{ status: number; body: unknown }> {
    const requestHash = createHash("sha256").update(JSON.stringify({ pay: id })).digest("hex");
    return inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${actor}:${idempotencyKey}`]);
      const seen = await client.query<{ request_hash: string; status: number; response: unknown }>(
        "SELECT request_hash, status, response FROM idempotency WHERE client = $1 AND key = $2",
        [actor, idempotencyKey],
      );
      if (seen.rows[0]) {
        if (seen.rows[0].request_hash !== requestHash) throw new HttpError(422, "This Idempotency-Key was used for a different payment.");
        return { status: seen.rows[0].status, body: seen.rows[0].response };
      }
      const found = await lockBill(client, id);
      if (!found) return { status: 404, body: { error: "No such bill." } };
      if (found.status === "paid") return { status: 409, body: { error: `${found.invoice_number} is already paid.` } };
      if (found.pay_to_iban !== found.vendor_iban) {
        return { status: 422, body: { error: `${found.invoice_number} was posted to a bank account the vendor's record no longer has.` } };
      }
      const paidAt = await pay(client, found, actor, because);
      const result = { status: 200, body: { id, paidAt, total: money(found.total), iban: found.pay_to_iban } };
      // Only a payment is remembered, so a refusal a person fixes can be tried again with the same key.
      await client.query("INSERT INTO idempotency (client, key, request_hash, status, response) VALUES ($1, $2, $3, $4, $5)", [
        actor, idempotencyKey, requestHash, result.status, JSON.stringify(result.body),
      ]);
      return result;
    });
  }
}

type LockedBill = { id: string; total: string; status: string; invoice_number: string; pay_to_iban: string; vendor_iban: string };

async function lockBill(client: PoolClient, id: string): Promise<LockedBill | null> {
  const { rows } = await client.query<LockedBill>(
    `SELECT b.id, b.total, b.status, b.invoice_number, b.pay_to_iban, v.iban AS vendor_iban
     FROM bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1 FOR UPDATE OF b`,
    [id],
  );
  return rows[0] ?? null;
}

// Money leaves the bank: the bill moves out of accounts payable, and the audit log says who and why.
async function pay(client: PoolClient, found: LockedBill, actor: string, because: string): Promise<string> {
  const entryId = randomUUID();
  await client.query("INSERT INTO journal_entries (id, bill_id, entry_date, memo) VALUES ($1, $2, current_date, $3)", [entryId, found.id, `Payment ${found.invoice_number}`]);
  await client.query("INSERT INTO journal_lines (entry_id, position, account, debit, credit) VALUES ($1, 1, '2000', $2, 0), ($1, 2, '1000', 0, $2)", [entryId, found.total]);
  const { rows } = await client.query<{ paid_at: Date }>(
    "UPDATE bills SET status = 'paid', paid_at = now(), paid_by = $2 WHERE id = $1 RETURNING paid_at",
    [found.id, actor],
  );
  await audit(client, actor, "bill.paid", found.id, { total: money(found.total), iban: found.pay_to_iban, because });
  return rows[0].paid_at.toISOString();
}

async function audit(client: PoolClient, actor: string, action: string, subject: string, detail: unknown) {
  await client.query("INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1, $2, $3, $4)", [actor, action, subject, JSON.stringify(detail)]);
}

const round = (value: number) => Math.round(value * 100) / 100;
const dateText = (value: unknown) => (value ? String(value) : null);

function vendor(row: Record<string, unknown>): Vendor {
  return {
    id: String(row.id), name: String(row.name), email: String(row.email), iban: String(row.iban),
    currency: String(row.currency), requiresPo: Boolean(row.requires_po), expenseAccount: String(row.expense_account),
  };
}

function purchaseOrder(row: Record<string, unknown>) {
  return {
    number: String(row.number), vendorId: String(row.vendor_id), vendor: String(row.vendor), amount: money(row.amount),
    currency: String(row.currency), status: row.status as "open" | "closed", description: String(row.description),
  };
}

function bill(row: Record<string, unknown>) {
  return {
    id: String(row.id), vendorId: String(row.vendor_id), vendor: String(row.vendor), invoiceNumber: String(row.invoice_number),
    invoiceDate: dateText(row.invoice_date), dueDate: dateText(row.due_date), poNumber: (row.po_number as string | null) ?? null,
    currency: String(row.currency), net: money(row.net), tax: money(row.tax), total: money(row.total), status: String(row.status),
    postedBy: String(row.posted_by), postedBecause: String(row.posted_because), source: (row.source as string | null) ?? null,
    payToIban: String(row.pay_to_iban), vendorIban: String(row.vendor_iban),
    paidAt: row.paid_at ? (row.paid_at as Date).toISOString() : null, paidBy: (row.paid_by as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
