import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { testDatabase } from "../../src/server/test-database";
import { Books } from "./store";

// Paying a bill is the one write where money leaves the company. QuirkBooks itself refuses a bill
// whose vendor's bank changed after it was posted, so no caller can pay one by mistake.

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const RENT = "3a1c9e7b-5d2f-4b8a-9c6e-1f0d2b4a6c02";
const CHANGED_BANK = "4b2d0f8c-6e3a-4c9b-8d7f-2a1e3c5b7d03";
const LICENCE = "5b7f0c2e-9d1a-4e3b-8c6f-2a4d1e7b9c01";
let pool: Pool;
let close: () => Promise<void>;
let books: Books;

before(async () => {
  ({ pool, close } = await testDatabase(migrations));
  books = new Books(pool);
});
after(() => close());

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function payments(billId: string): Promise<number> {
  const { rows } = await pool.query("SELECT count(*)::int AS count FROM journal_entries WHERE bill_id = $1 AND memo LIKE 'Payment %'", [billId]);
  return rows[0].count;
}

test("the bills due this week are the open ones, overdue included, with both bank accounts", async () => {
  const due = await books.bills({ dueBy: inDays(5) });
  assert.deepEqual(due.map((bill) => bill.invoiceNumber).sort(), ["CC-5480", "HL-2026-11", "PF-8812"]);
  const copperleaf = due.find((bill) => bill.id === CHANGED_BANK)!;
  assert.notEqual(copperleaf.payToIban, copperleaf.vendorIban);
  const rent = due.find((bill) => bill.id === RENT)!;
  assert.equal(rent.payToIban, rent.vendorIban);
});

test("a bill whose vendor's bank changed after posting is refused and stays open", async () => {
  const result = await books.payBill(CHANGED_BANK, "Pay run approved.", "mission-control", "pay:changed");
  assert.equal(result.status, 422);
  assert.equal((await books.bill(CHANGED_BANK))!.status, "open");
  assert.equal(await payments(CHANGED_BANK), 0);
});

test("a payment moves the bill out of payables once, and a retry with the same key gives the first answer", async () => {
  const first = await books.payBill(RENT, "Pay run approved by Ada.", "mission-control", `pay:${RENT}`);
  const again = await books.payBill(RENT, "Pay run approved by Ada.", "mission-control", `pay:${RENT}`);
  assert.equal(first.status, 200);
  assert.deepEqual(again, first);
  assert.equal(await payments(RENT), 1);
  const paid = (await books.bill(RENT))!;
  assert.equal(paid.status, "paid");
  assert.equal(paid.paidBy, "mission-control");
  const { rows } = await pool.query("SELECT detail FROM audit_log WHERE action = 'bill.paid' AND subject = $1", [RENT]);
  assert.equal(rows[0].detail.because, "Pay run approved by Ada.");
});

test("two payments of one bill at once with different keys still pay it once", async () => {
  const results = await Promise.all([
    books.payBill(LICENCE, "Pay run approved.", "mission-control", "pay:a"),
    books.payBill(LICENCE, "Pay run approved.", "mission-control", "pay:b"),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(await payments(LICENCE), 1);
});

test("a new bill keeps the bank account its vendor had when it was posted", async () => {
  const posted = await books.postBill(
    {
      vendorId: "V-005", invoiceNumber: "CC-9001", invoiceDate: inDays(0), dueDate: inDays(10), poNumber: null, currency: "EUR",
      lines: [{ description: "Lunch", amount: 100 }], tax: 0, total: 100, postedBecause: "Every check passed.", source: null,
    },
    "mission-control",
    "post:CC-9001",
  );
  const bill = (await books.bill((posted.body as { id: string }).id))!;
  assert.equal(bill.payToIban, "ES9121000418450200051332");
});
