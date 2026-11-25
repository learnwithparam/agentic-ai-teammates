import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import * as page from "../../src/client/quirkbooks/api";
import { testDatabase } from "../../src/server/test-database";
import { Books } from "./store";

// The QuirkBooks page reads the store's answers through its own schemas: every tab, with a bill
// posted and paid, so the journal and the audit log hold real rows.

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
let pool: Pool;
let close: () => Promise<void>;
let books: Books;

before(async () => {
  ({ pool, close } = await testDatabase(migrations));
  books = new Books(pool);
});
after(() => close());

test("the page reads every tab of the books", async () => {
  const posted = await books.postBill(
    {
      vendorId: "V-004",
      invoiceNumber: "HL-SHAPE-1",
      invoiceDate: "2026-11-24",
      // An invoice with no due date once stopped the live Bills tab from loading.
      dueDate: null,
      poNumber: null,
      currency: "EUR",
      lines: [{ description: "Studio rent", amount: 1500 }],
      tax: 0,
      total: 1500,
      postedBecause: "Every check passed.",
      source: null,
    },
    "mission-control",
    "bill:shape",
  );
  assert.equal(posted.status, 201);
  const [bill] = page.Bills.parse(await books.bills());
  await books.markPaid(bill.id, "ada@bramble.example");

  assert.equal(page.Bills.parse(await books.bills())[0].status, "paid");
  assert.ok(page.Vendors.parse(await books.vendors()).length > 0);
  assert.ok(page.PurchaseOrders.parse(await books.purchaseOrders()).length > 0);
  assert.equal(page.BillLines.parse(await books.billLines(bill.id))[0].amount, 1500);
  assert.ok(page.Journal.parse(await books.journal()).length >= 4, "the bill and its payment each make two lines");
  assert.ok(page.AuditLog.parse(await books.auditLog()).length >= 2);
});
