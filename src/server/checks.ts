import { z } from "zod";

// The checks an invoice must pass before it posts with no one looking. Each is plain code over
// QuirkBooks' own records, so a model can never talk its way past one. The gateway runs them
// again just before it posts, whatever the teammate says.

const Line = z.object({ description: z.string().min(1), amount: z.number() });

export const Invoice = z.object({
  vendorName: z.string().min(1),
  vendorEmail: z.string().nullable(),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  iban: z.string().nullable(),
  poNumber: z.string().nullable(),
  lines: z.array(Line).min(1),
  tax: z.number(),
  total: z.number(),
});
export type Invoice = z.infer<typeof Invoice>;

// What QuirkBooks knows, fetched by the gateway with its own key.
export type Vendor = { id: string; name: string; email: string; iban: string; currency: string; requiresPo: boolean };
export type PurchaseOrder = { number: string; vendorId: string; amount: number; currency: string; status: "open" | "closed" };
// The sender is the address the mail really came from, or null for a file a person put in the drive.
export type BookFacts = { vendor: Vendor | null; po: PurchaseOrder | null; duplicateBillId: string | null; sender: string | null };

export type CheckRules = {
  // The company's books are kept in this currency.
  currency: string;
  // Above this total a person decides, even when everything else passes.
  autoPostLimit: number;
  // How far over its purchase order an invoice may go, as a share: 0.05 is 5%.
  poTolerance: number;
};

export const REASONS = {
  arithmetic: "The lines and tax do not add up to the total.",
  unknown_vendor: "QuirkBooks has no vendor with this name or email.",
  sender_unknown: "The mail did not come from the address QuirkBooks has for this vendor.",
  bank_changed: "The bank account on the invoice is not the one QuirkBooks has for this vendor.",
  duplicate: "QuirkBooks already has a bill with this invoice number from this vendor.",
  po_missing: "This vendor needs a purchase order, and the invoice names none that QuirkBooks has.",
  po_mismatch: "The purchase order belongs to another vendor or is closed.",
  po_over_tolerance: "The total is more than the purchase order allows.",
  currency: "The invoice is not in the currency of the books or of the vendor.",
  over_limit: "The total is above what may post without a person.",
} as const;
export type Reason = keyof typeof REASONS;

// How far over its purchase order an invoice may go before a person looks.
export const PO_TOLERANCE = 0.05;

const CENT = 0.005;

// Bank account numbers are compared without spaces or case: "DE89 3704" equals "de893704".
export function sameAccount(first: string, second: string): boolean {
  const plain = (value: string) => value.replace(/\s+/g, "").toUpperCase();
  return plain(first) === plain(second);
}

export function checkInvoice(invoice: Invoice, facts: BookFacts, rules: CheckRules): Reason[] {
  const reasons: Reason[] = [];
  const lineSum = invoice.lines.reduce((sum, line) => sum + line.amount, 0);
  if (Math.abs(lineSum + invoice.tax - invoice.total) > CENT) reasons.push("arithmetic");
  const { vendor, po } = facts;
  if (!vendor) reasons.push("unknown_vendor");
  if (vendor && invoice.iban && !sameAccount(invoice.iban, vendor.iban)) reasons.push("bank_changed");
  if (vendor && facts.sender && facts.sender.trim().toLowerCase() !== vendor.email.trim().toLowerCase()) reasons.push("sender_unknown");
  if (facts.duplicateBillId) reasons.push("duplicate");
  if (vendor?.requiresPo && !po) reasons.push("po_missing");
  if (po && (po.vendorId !== vendor?.id || po.status !== "open")) reasons.push("po_mismatch");
  if (po && invoice.total > po.amount * (1 + rules.poTolerance) + CENT) reasons.push("po_over_tolerance");
  if (invoice.currency !== rules.currency || (vendor && invoice.currency !== vendor.currency)) reasons.push("currency");
  if (invoice.total > rules.autoPostLimit) reasons.push("over_limit");
  return reasons;
}

// What the gateway says when a card for the same bill already waits. The invoice teammate reads
// it as "nothing to send": the person already has the bill in front of them.
export const CARD_WAITS = "A card for this bill already waits for a person";
