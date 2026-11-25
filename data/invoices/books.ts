import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BookFacts, checkInvoice, type Invoice, PO_TOLERANCE, type PurchaseOrder, type Reason, type Vendor } from "../../src/server/checks";
import { COMPANIES } from "../../src/server/people";
import type { InvoiceCase } from "./cases";

// QuirkBooks's books as they are when it starts, read from its own seed migration. The labels
// and the eval check each case against these, never against books a live run has changed.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const seed = readFileSync(path.join(root, "apps/quirkbooks/migrations/001_books.sql"), "utf8");
// The teammate's auto-post limit when it starts, from Mission Control's migration.
const runtime = readFileSync(path.join(root, "src/server/migrations/003_runtime.sql"), "utf8");
export const AUTO_POST_LIMIT = Number(/auto_post_limit numeric\(14, 2\) NOT NULL DEFAULT (\d+)/.exec(runtime)![1]);

function seedRows(table: string): string[][] {
  const block = new RegExp(`INSERT INTO ${table} \\([^)]*\\) VALUES([\\s\\S]*?);`).exec(seed)![1];
  const unquote = (value: string) => value.trim().replace(/^'|'$/g, "");
  return [...block.matchAll(/\(([^)]*)\)/g)].map((row) => row[1].split(",").map(unquote));
}

export const vendors: Vendor[] = seedRows("vendors").map(([id, name, email, iban, currency, requiresPo]) => ({ id, name, email, iban, currency, requiresPo: requiresPo === "true" }));
export const orders: PurchaseOrder[] = seedRows("purchase_orders").map(([number, vendorId, amount, currency, status]) => ({ number, vendorId, amount: Number(amount), currency, status: status as "open" | "closed" }));
export const billed = [...seed.matchAll(/INSERT INTO bills \([^)]*\)\s*VALUES \('[^']*', '([^']*)', '([^']*)'/g)].map((row) => ({ vendorId: row[1], number: row[2] }));

// Who sent the case: nobody for a file in LDrive, else the From address of its mail.
export function senderOf(invoice: InvoiceCase): string | null {
  return invoice.channel === "drive" ? null : (invoice.from ?? invoice.vendor.email);
}

// The same lookup QuirkBooks runs: a vendor by name, by address, or by the address's domain.
function findVendor(name: string, email: string | null): Vendor | null {
  const terms = [name, email].filter((term): term is string => Boolean(term)).map((term) => term.toLowerCase());
  const domain = (address: string) => address.split("@")[1] ?? "";
  const matches = (vendor: Vendor, term: string) =>
    vendor.name.toLowerCase() === term || vendor.email.toLowerCase() === term || (term.includes("@") && domain(vendor.email) === domain(term));
  return vendors.find((vendor) => terms.some((term) => matches(vendor, term))) ?? null;
}

export function factsFor(invoice: Invoice, sender: string | null): BookFacts {
  const vendor = findVendor(invoice.vendorName, sender ?? invoice.vendorEmail);
  const purchaseOrder = orders.find((order) => order.number === invoice.poNumber) ?? null;
  const duplicate = billed.find((bill) => bill.vendorId === vendor?.id && bill.number.toLowerCase() === invoice.invoiceNumber.toLowerCase());
  return { vendor, po: purchaseOrder, duplicateBillId: duplicate ? "seeded" : null, sender };
}

export function reasonsFor(invoice: Invoice, sender: string | null): Reason[] {
  return checkInvoice(invoice, factsFor(invoice, sender), { currency: COMPANIES.bramble.currency, autoPostLimit: AUTO_POST_LIMIT, poTolerance: PO_TOLERANCE });
}

// A case's invoice exactly as it was written, which a perfect reading would give.
export function asWritten(invoice: InvoiceCase): Invoice {
  const { vendor, number, date, due, currency, iban, poNumber, lines, tax, total } = invoice;
  return { vendorName: vendor.name, vendorEmail: vendor.email, invoiceNumber: number, invoiceDate: date, dueDate: due, currency, iban, poNumber, lines, tax, total };
}
