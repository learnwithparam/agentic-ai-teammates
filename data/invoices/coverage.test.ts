import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type BookFacts, checkInvoice, PO_TOLERANCE, type PurchaseOrder, REASONS, type Vendor } from "../../src/server/checks";
import { COMPANIES } from "../../src/server/people";
import { CASES, type InvoiceCase } from "./cases";
import { fileName, renderBody, renderPdf } from "./render";

// The dataset's labels are not trusted by hand. Each case's expected reasons must be what the
// checks give against QuirkBooks's own seed. Every committed file must be what render.ts
// writes. And docs/coverage.md must name every case.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const seed = readFileSync(path.join(root, "apps/quirkbooks/migrations/001_books.sql"), "utf8");
const coverage = readFileSync(path.join(root, "docs/coverage.md"), "utf8");
// The teammate's auto-post limit when QuirkBooks starts, from Mission Control's migration.
const AUTO_POST_LIMIT = Number(/auto_post_limit numeric\(14, 2\) NOT NULL DEFAULT (\d+)/.exec(readFileSync(path.join(root, "src/server/migrations/003_runtime.sql"), "utf8"))![1]);

function seedRows(table: string): string[][] {
  const block = new RegExp(`INSERT INTO ${table} \\([^)]*\\) VALUES([\\s\\S]*?);`).exec(seed)![1];
  const unquote = (value: string) => value.trim().replace(/^'|'$/g, "");
  return [...block.matchAll(/\(([^)]*)\)/g)].map((row) => row[1].split(",").map(unquote));
}

const vendors: Vendor[] = seedRows("vendors").map(([id, name, email, iban, currency, requiresPo]) => ({ id, name, email, iban, currency, requiresPo: requiresPo === "true" }));
const orders: PurchaseOrder[] = seedRows("purchase_orders").map(([number, vendorId, amount, currency, status]) => ({ number, vendorId, amount: Number(amount), currency, status: status as "open" | "closed" }));
const billed = [...seed.matchAll(/INSERT INTO bills \([^)]*\)\s*VALUES \('[^']*', '([^']*)', '([^']*)'/g)].map((row) => ({ vendorId: row[1], number: row[2] }));

function factsFor(invoice: InvoiceCase): BookFacts {
  const sender = invoice.channel === "drive" ? null : (invoice.from ?? invoice.vendor.email);
  const vendor = vendors.find((entry) => entry.email === sender) ?? vendors.find((entry) => entry.name === invoice.vendor.name) ?? null;
  const purchaseOrder = orders.find((order) => order.number === invoice.poNumber) ?? null;
  const duplicate = billed.find((bill) => bill.vendorId === vendor?.id && bill.number === invoice.number);
  return { vendor, po: purchaseOrder, duplicateBillId: duplicate ? "seeded" : null, sender };
}

function reasonsFor(invoice: InvoiceCase) {
  const { vendor, number, date, due, currency, iban, poNumber, lines, tax, total } = invoice;
  const read = { vendorName: vendor.name, vendorEmail: vendor.email, invoiceNumber: number, invoiceDate: date, dueDate: due, currency, iban, poNumber, lines, tax, total };
  return checkInvoice(read, factsFor(invoice), { currency: COMPANIES.bramble.currency, autoPostLimit: AUTO_POST_LIMIT, poTolerance: PO_TOLERANCE });
}

test("the seed parses into the vendors and purchase orders the cases use", () => {
  assert.equal(vendors.length, 6);
  assert.equal(orders.length, 3);
  assert.deepEqual(billed, [{ vendorId: "V-002", number: "PF-8812" }]);
});

for (const invoice of CASES) {
  test(`${invoice.id} is labelled with what the checks give`, () => {
    const reasons = reasonsFor(invoice);
    if (invoice.expected.outcome === "posted") assert.deepEqual(reasons, []);
    else if (invoice.expected.outcome === "approval") assert.deepEqual(reasons, invoice.expected.reasons);
    // A screened invoice never reaches the checks. If screening missed it, the checks still stop it.
    else assert.ok(reasons.length > 0, "A screened case must also fail a check.");
  });

  test(`${invoice.id} on disk is what render.ts writes`, async () => {
    const file = readFileSync(path.join(root, "data/invoices/files", fileName(invoice.id, invoice.channel)));
    const expected = invoice.channel === "mail-body" ? Buffer.from(renderBody(invoice)) : await renderPdf(invoice);
    assert.ok(file.equals(expected), "Run npm run invoices:make and commit the files.");
  });
}

test("every reason, and every way in, has a case", () => {
  const labelled = new Set(CASES.flatMap((invoice) => (invoice.expected.outcome === "approval" ? invoice.expected.reasons : [])));
  assert.deepEqual([...labelled].sort(), Object.keys(REASONS).sort());
  assert.deepEqual([...new Set(CASES.map((invoice) => invoice.channel))].sort(), ["drive", "mail-body", "mail-pdf"]);
  assert.ok(CASES.some((invoice) => invoice.expected.outcome === "screened"));
});

test("docs/coverage.md names every case, and only real ones", () => {
  const named = new Set([...coverage.matchAll(/`(\d\d-[a-z0-9-]+)`/g)].map((match) => match[1]));
  assert.deepEqual([...named].sort(), CASES.map((invoice) => invoice.id).sort());
});
