import assert from "node:assert/strict";
import { test } from "node:test";
import { type BookFacts, type CheckRules, checkInvoice, type Invoice, REASONS, type Reason } from "./checks";

const rules: CheckRules = { currency: "EUR", autoPostLimit: 2500, poTolerance: 0.05 };

const clean: Invoice = {
  vendorName: "Northwind Paper Co.",
  vendorEmail: "billing@northwind.example",
  invoiceNumber: "NW-2026-118",
  invoiceDate: "2026-11-02",
  dueDate: "2026-12-02",
  currency: "EUR",
  iban: "DE89 3704 0044 0532 0130 00",
  poNumber: "PO-1042",
  lines: [
    { description: "Recycled paper, 40 reams", amount: 760 },
    { description: "Delivery", amount: 40 },
  ],
  tax: 152,
  total: 952,
};

const facts: BookFacts = {
  vendor: { id: "V-001", name: "Northwind Paper Co.", email: "billing@northwind.example", iban: "DE89370400440532013000", currency: "EUR", requiresPo: true },
  po: { number: "PO-1042", vendorId: "V-001", amount: 1000, currency: "EUR", status: "open" },
  duplicateBillId: null,
};

function only(invoice: Invoice, bookFacts: BookFacts): Reason[] {
  return checkInvoice(invoice, bookFacts, rules);
}

test("a clean invoice passes every check, with the account compared without spaces", () => {
  assert.deepEqual(only(clean, facts), []);
});

// One case per reason, each changing a single fact of the clean invoice.
const cases: Record<Reason, [Invoice, BookFacts]> = {
  arithmetic: [{ ...clean, total: 962 }, { ...facts, po: { ...facts.po!, amount: 1200 } }],
  unknown_vendor: [{ ...clean, poNumber: null }, { vendor: null, po: null, duplicateBillId: null }],
  bank_changed: [{ ...clean, iban: "GB33 BUKB 2020 1555 5555 55" }, facts],
  duplicate: [clean, { ...facts, duplicateBillId: "bill-7" }],
  po_missing: [{ ...clean, poNumber: null }, { ...facts, po: null }],
  po_mismatch: [clean, { ...facts, po: { ...facts.po!, status: "closed" } }],
  po_over_tolerance: [clean, { ...facts, po: { ...facts.po!, amount: 900 } }],
  currency: [clean, { ...facts, vendor: { ...facts.vendor!, currency: "GBP" } }],
  over_limit: [
    { ...clean, lines: [{ description: "Paper", amount: 2400 }], tax: 480, total: 2880 },
    { ...facts, po: { ...facts.po!, amount: 3000 } },
  ],
};

for (const [reason, [invoice, bookFacts]] of Object.entries(cases)) {
  test(`${reason} fails on its own: ${REASONS[reason as Reason]}`, () => {
    assert.deepEqual(only(invoice, bookFacts), [reason]);
  });
}

test("every reason has a case", () => {
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(REASONS).sort());
});

test("five percent over the purchase order still passes, a cent more does not", () => {
  const atEdge = { ...facts, po: { ...facts.po!, amount: 952 / 1.05 } };
  assert.deepEqual(only(clean, atEdge), []);
  assert.deepEqual(only({ ...clean, lines: [{ description: "Paper", amount: 800.02 }], total: 952.02 }, atEdge), ["po_over_tolerance"]);
});
