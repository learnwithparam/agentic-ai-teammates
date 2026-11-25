import { z } from "zod";
import type { Accounting } from "../adapters/types";
import { payloadHash } from "../canonical";
import { checkInvoice, Invoice, PO_TOLERANCE, type Reason, REASONS } from "../checks";
import { COMPANIES } from "../people";
import { defineTool, readTool } from "./define";
import { InvoiceSource, Text } from "./shapes";

// QuirkBooks: vendors, purchase orders and bills.

// The one way an invoice is matched to a vendor. The real sender comes first: an address
// printed on the invoice proves nothing.
export function matchVendor(books: Accounting, invoice: Invoice, source: InvoiceSource) {
  return books.findVendor(invoice.vendorName, source.sender ?? invoice.vendorEmail);
}

async function bookFacts(books: Accounting, invoice: Invoice, source: InvoiceSource) {
  const vendor = await matchVendor(books, invoice, source);
  const purchaseOrder = invoice.poNumber ? await books.purchaseOrder(invoice.poNumber) : null;
  const duplicates = vendor ? await books.bills(vendor.id, invoice.invoiceNumber) : [];
  return { vendor, po: purchaseOrder, duplicateBillId: duplicates[0]?.id ?? null, sender: source.sender };
}

export const PostBillArgs = z.object({ invoice: Invoice, source: InvoiceSource, brief: z.string().min(1).max(1500).nullable() });

export const booksTools = {
  "books.find_vendor": readTool(
    "Find a vendor in QuirkBooks by name or email address.",
    z.object({ name: Text, email: z.string().max(200).nullable() }),
    async (ctx, args) => ({ vendor: await ctx.deps.books.findVendor(args.name, args.email) }),
  ),
  "books.purchase_order": readTool("Read one purchase order by its number, such as PO-1042.", z.object({ number: Text }), async (ctx, args) => ({
    purchaseOrder: await ctx.deps.books.purchaseOrder(args.number),
  })),
  "books.vendor_bills": readTool("List the bills QuirkBooks already has from one vendor, newest first.", z.object({ vendorId: Text }), async (ctx, args) => ({
    bills: (await ctx.deps.books.bills(args.vendorId)).slice(0, 20),
  })),
  "books.post_bill": defineTool({
    description: "Post an invoice to QuirkBooks as a bill.",
    args: PostBillArgs,
    // The guard runs the invoice checks again, here, where only the gateway's own reads count.
    // A bill posts at once only when every check passes and the total is within the teammate's limit.
    decision: "allow",
    readOnly: false,
    ruleReason: "standing_rule",
    guard: async (ctx, args) => {
      const facts = await bookFacts(ctx.deps.books, args.invoice, args.source);
      const company = COMPANIES[ctx.scope.company];
      const reasons = checkInvoice(args.invoice, facts, { currency: company.currency, autoPostLimit: ctx.teammate.autoPostLimit, poTolerance: PO_TOLERANCE });
      return { reasons, state: facts };
    },
    card: (args, reasons) => ({
      title: `${args.invoice.vendorName} ${args.invoice.invoiceNumber}`,
      brief: args.brief ?? reasons.map((reason) => REASONS[reason as Reason] ?? "A standing rule asks a person to approve every bill.").join(" "),
      amount: args.invoice.total,
      currency: args.invoice.currency,
      // A failed check is a fact about one invoice, so it never offers "allow always".
      canAllowAlways: false,
    }),
    run: async (ctx, args, grant, facts) => {
      const { invoice, source } = args;
      const found = facts ?? (await bookFacts(ctx.deps.books, invoice, source));
      if (!found.vendor) return { status: "denied", reason: "QuirkBooks has no such vendor. Add the vendor in QuirkBooks, then send the invoice again." };
      const poBelongs = found.po && found.po.vendorId === found.vendor.id;
      const key = `bill:${payloadHash({ kind: source.kind, id: source.id, attachmentId: source.attachmentId, invoiceNumber: invoice.invoiceNumber })}`;
      const posted = await ctx.deps.books.postBill(
        {
          vendorId: found.vendor.id,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate,
          dueDate: invoice.dueDate,
          poNumber: poBelongs ? invoice.poNumber : null,
          currency: invoice.currency,
          lines: invoice.lines,
          tax: invoice.tax,
          total: invoice.total,
          postedBecause: grant.because,
          source: `${source.kind}:${source.id}`,
        },
        key,
      );
      if ("duplicateOf" in posted) return { status: "done", result: { posted: false, duplicateOf: posted.duplicateOf } };
      return { status: "done", result: { posted: true, billId: posted.id, total: posted.total } };
    },
  }),
};
