import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { testDatabase } from "../../src/server/test-database";
import { Books, type NewBill } from "./store";

// A worker that crashes after the bill is posted, but before it marks the event done, posts again
// on the retry with the same key. These tests pin that the retry never makes a second bill.

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
let pool: Pool;
let close: () => Promise<void>;
let books: Books;

before(async () => {
  ({ pool, close } = await testDatabase(migrations));
  books = new Books(pool);
});
after(() => close());

function harborBill(invoiceNumber: string, total = 1500): NewBill {
  return {
    vendorId: "V-004",
    invoiceNumber,
    invoiceDate: "2026-11-24",
    dueDate: "2026-12-01",
    poNumber: null,
    currency: "EUR",
    lines: [{ description: "Studio rent", amount: total }],
    tax: 0,
    total,
    postedBecause: "Every check passed.",
    source: null,
  };
}

async function billsNumbered(invoiceNumber: string): Promise<number> {
  const { rows } = await pool.query("SELECT count(*)::int AS count FROM bills WHERE invoice_number = $1", [invoiceNumber]);
  return rows[0].count;
}

test("posting again with the same key gives the first answer and no second bill", async () => {
  const first = await books.postBill(harborBill("HL-TEST-1"), "mission-control", "bill:retry");
  const again = await books.postBill(harborBill("HL-TEST-1"), "mission-control", "bill:retry");
  assert.equal(first.status, 201);
  assert.deepEqual(again, first);
  assert.equal(await billsNumbered("HL-TEST-1"), 1);
});

test("two posts with the same key at once still make one bill", async () => {
  const results = await Promise.all([1, 2, 3].map(() => books.postBill(harborBill("HL-TEST-2"), "mission-control", "bill:race")));
  assert.deepEqual(results.map((result) => result.status), [201, 201, 201]);
  assert.equal(await billsNumbered("HL-TEST-2"), 1);
});

test("the same key with a different bill is refused", async () => {
  await books.postBill(harborBill("HL-TEST-3"), "mission-control", "bill:reused");
  await assert.rejects(books.postBill(harborBill("HL-TEST-3", 1600), "mission-control", "bill:reused"), /used for a different bill/);
  assert.equal(await billsNumbered("HL-TEST-3"), 1);
});

test("a new key for an invoice already in the books is a duplicate, not a second bill", async () => {
  await books.postBill(harborBill("HL-TEST-4"), "mission-control", "bill:one");
  const second = await books.postBill(harborBill("HL-TEST-4"), "mission-control", "bill:two");
  assert.equal(second.status, 409);
  assert.equal(await billsNumbered("HL-TEST-4"), 1);
});
