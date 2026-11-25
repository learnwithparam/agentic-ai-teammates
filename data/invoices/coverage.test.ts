import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REASONS } from "../../src/server/checks";
import { asWritten, billed, orders, reasonsFor, senderOf, vendors } from "./books";
import { CASES, type InvoiceCase } from "./cases";
import { fileName, renderBody, renderPdf } from "./render";

// The dataset's labels are not trusted by hand. Each case's expected reasons must be what the
// checks give against QuirkBooks's own seed. Every committed file must be what render.ts
// writes. And docs/coverage.md must name every case.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const coverage = readFileSync(path.join(root, "docs/coverage.md"), "utf8");

test("the seed parses into the vendors and purchase orders the cases use", () => {
  assert.equal(vendors.length, 6);
  assert.equal(orders.length, 3);
  assert.deepEqual(billed, [{ vendorId: "V-002", number: "PF-8812" }]);
});

for (const invoice of CASES) {
  test(`${invoice.id} is labelled with what the checks give`, () => {
    const reasons = reasonsFor(asWritten(invoice), senderOf(invoice));
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
