import { z } from "zod";

// What QuirkBooks' server answers, read with the same shapes apps/quirkbooks/page-shapes.test.ts
// checks against the real store. A change on one side fails there.

const Vendor = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  iban: z.string(),
  currency: z.string(),
  requiresPo: z.boolean(),
  expenseAccount: z.string(),
});
export const Vendors = z.array(Vendor);
export type Vendor = z.infer<typeof Vendor>;

const PurchaseOrder = z.object({
  number: z.string(),
  vendor: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.enum(["open", "closed"]),
  description: z.string(),
});
export const PurchaseOrders = z.array(PurchaseOrder);

export const Bills = z.array(
  z.object({
    id: z.string(),
    vendor: z.string(),
    invoiceNumber: z.string(),
    invoiceDate: z.string(),
    // An invoice may name no due date.
    dueDate: z.string().nullable(),
    poNumber: z.string().nullable(),
    currency: z.string(),
    net: z.number(),
    tax: z.number(),
    total: z.number(),
    status: z.enum(["open", "paid"]),
    postedBy: z.string(),
    postedBecause: z.string(),
    createdAt: z.string(),
  }),
);
export type Bill = z.infer<typeof Bills>[number];

export const BillLines = z.array(z.object({ position: z.number(), description: z.string(), amount: z.number() }));

const JournalLine = z.object({
  entryId: z.string(),
  date: z.string(),
  memo: z.string(),
  account: z.string(),
  accountName: z.string(),
  debit: z.number(),
  credit: z.number(),
});
export const Journal = z.array(JournalLine);
export type JournalLine = z.infer<typeof JournalLine>;

const AuditEntry = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  subject: z.string(),
  detail: z.unknown(),
  at: z.string(),
});
export const AuditLog = z.array(AuditEntry);
