import { z } from "zod";
import type { Accounting } from "../adapters/types";
import { payloadHash } from "../canonical";
import { CARD_WAITS, checkInvoice, Invoice, PO_TOLERANCE, type Reason, REASONS } from "../checks";
import { daysAfter, payProblems, runTotal } from "../payments";
import { COMPANIES } from "../people";
import { askerAsPerson, Authority } from "./asker";
import { defineTool, readTool, type ToolContext } from "./define";
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

// requestId names the person.request a person handed over, when the bill came from one.
export const PostBillArgs = z.object({
  invoice: Invoice,
  source: InvoiceSource,
  brief: z.string().min(1).max(1500).nullable(),
  requestId: z.uuid().nullable().optional(),
});

const WithinDays = z.number().int().min(0).max(31);
const DueBillsArgs = z.object({ day: z.iso.date(), withinDays: WithinDays });

// A pay run names its bills and the total and currency a person approves. The guard checks all
// three against the books, so the amount on the card is never the model's or the caller's word.
export const PayBillArgs = z.object({
  day: z.iso.date(),
  billIds: z.array(z.uuid()).min(1).max(20),
  total: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const Request = z.object({ requestId: z.uuid(), from: z.string(), source: InvoiceSource, authority: Authority });

// The request a person handed over, read from the inbox row only the gateway writes.
async function handedOver(ctx: ToolContext, requestId: string) {
  const { rows } = await ctx.deps.pool.query<{ payload: unknown }>(
    "SELECT payload FROM inbox_events WHERE company = $1 AND teammate = $2 AND source = 'request' AND type = 'person.request' AND source_id = $3",
    [ctx.scope.company, ctx.scope.teammate, requestId],
  );
  return rows[0] ? Request.parse(rows[0].payload) : null;
}

// A card already waiting for the same bill, from another mail or file. A vendor who sends the
// invoice twice gets one card, not two. The same thread is left out: a retried run reuses its card.
async function waitingCard(ctx: ToolContext, invoice: Invoice) {
  const { rows } = await ctx.deps.pool.query<{ id: string }>(
    `SELECT id FROM approvals WHERE company = $1 AND teammate = $2 AND tool = 'books.post_bill' AND status = 'pending' AND thread_id <> $3
       AND args->'invoice'->>'invoiceNumber' = $4 AND lower(args->'invoice'->>'vendorName') = lower($5) LIMIT 1`,
    [ctx.scope.company, ctx.scope.teammate, ctx.scope.threadId, invoice.invoiceNumber, invoice.vendorName],
  );
  return rows[0]?.id ?? null;
}

const sameDocument = (a: InvoiceSource, b: InvoiceSource) => a.kind === b.kind && a.id === b.id && a.attachmentId === b.attachmentId;

// A check's reason in words. The standing rule and a request's note are already words.
function cardReason(reason: string): string {
  if (reason in REASONS) return REASONS[reason as Reason];
  return reason === "standing_rule" ? "A standing rule asks a person to approve every bill." : reason;
}

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
    fixedPolicy: "Posting a bill always runs the invoice checks.",
    label: "Post a bill to QuirkBooks",
    readOnly: false,
    ruleReason: "standing_rule",
    guard: async (ctx, args) => {
      const request = args.requestId ? await handedOver(ctx, args.requestId) : null;
      if (args.requestId && (!request || !sameDocument(request.source, args.source))) return { deny: "That request does not name this document." };
      const waiting = await waitingCard(ctx, args.invoice);
      if (waiting) return { deny: `${CARD_WAITS}: ${args.invoice.vendorName} ${args.invoice.invoiceNumber}.` };
      const facts = await bookFacts(ctx.deps.books, args.invoice, args.source);
      const company = COMPANIES[ctx.scope.company];
      const reasons = checkInvoice(args.invoice, facts, { currency: company.currency, autoPostLimit: ctx.teammate.autoPostLimit, poTolerance: PO_TOLERANCE });
      if (!request) return { reasons, state: facts };
      const asked = `Asked by ${request.from}`;
      if (reasons.length === 0) return { reasons, state: facts, because: `${asked}. Every check passed.` };
      // Work a person handed over runs under their own limit. That limit lifts only the teammate's
      // auto-post limit: every other check still asks a person, and so does an amount above it.
      const onlyTheLimit = reasons.length === 1 && reasons[0] === "over_limit";
      if (!onlyTheLimit) return { reasons, state: facts };
      const person = askerAsPerson(request.authority, ctx.scope.company);
      const allowed = await ctx.deps.check(person, "can_decide", { type: "approval", id: request.requestId, company: ctx.scope.company }, { amount: args.invoice.total });
      if (allowed) return { reasons: [], state: facts, because: `${asked}, within their limit.` };
      return { reasons: [...reasons, `${request.from} asked for this, and it is above what they may approve alone.`], state: facts };
    },
    card: (args, reasons) => ({
      title: `${args.invoice.vendorName} ${args.invoice.invoiceNumber}`,
      brief: args.brief ?? reasons.map(cardReason).join(" "),
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
  "books.due_bills": readTool(
    "List the open bills due within some days of a day, overdue ones included, with the bank each one pays.",
    DueBillsArgs,
    async (ctx, args) => ({ bills: await ctx.deps.books.dueBills(daysAfter(args.day, args.withinDays)) }),
  ),
  "books.pay_bill": defineTool({
    description: "Pay a run of open bills in QuirkBooks, once a person approves the run.",
    args: PayBillArgs,
    // Money leaves the company, so a person decides every run, under their own approval limit.
    decision: "approve",
    fixedPolicy: "Money leaves the company, so a person approves every pay run.",
    label: "Pay bills in QuirkBooks",
    readOnly: false,
    guard: async (ctx, args) => {
      if (new Set(args.billIds).size !== args.billIds.length) return { deny: "The pay run names a bill twice." };
      const currency = COMPANIES[ctx.scope.company].currency;
      if (args.currency !== currency) return { deny: `A pay run is in ${currency}, the company's currency.` };
      const bills = await Promise.all(args.billIds.map((id) => ctx.deps.books.bill(id)));
      const missing = args.billIds.filter((_, index) => !bills[index]);
      if (missing.length) return { deny: `QuirkBooks has no bill ${missing.join(", ")}.` };
      const found = bills.map((bill) => bill!);
      const problems = found.flatMap((bill) => payProblems(bill, currency).map((problem) => `${bill.vendor} ${bill.invoiceNumber}: ${problem}`));
      if (problems.length) return { deny: problems.join(" ") };
      // The card's amount is what a person's approval limit is checked against, so it must be the books' own sum.
      const sum = runTotal(found);
      if (sum !== args.total) return { deny: `The bills add up to ${sum.toFixed(2)}, not ${args.total.toFixed(2)}.` };
      // The card lists each bill as QuirkBooks has it, so a person sees what they pay.
      return { state: found };
    },
    card: (args, _reasons, bills) => ({
      title: `Pay run for ${args.day}: ${args.billIds.length} ${args.billIds.length === 1 ? "bill" : "bills"}`,
      brief: "Every bill is open, in the company's currency, and goes to the bank account it was posted with.",
      amount: args.total,
      currency: args.currency,
      // Every pay run is its own decision, so it can never become a standing rule.
      canAllowAlways: false,
      lines: (bills ?? []).map((bill) => ({ label: `${bill.vendor} ${bill.invoiceNumber}`, detail: bill.dueDate ? `Due ${bill.dueDate}` : "No due date", amount: bill.total })),
    }),
    run: async (ctx, args, grant) => {
      const paid: string[] = [];
      const refused: { billId: string; reason: string }[] = [];
      for (const billId of args.billIds) {
        // One key per bill, so a retry of an approved run never pays a bill twice.
        const answer = await ctx.deps.books.payBill(billId, `pay:${billId}`, grant.because);
        if ("refused" in answer) refused.push({ billId, reason: answer.refused });
        else paid.push(billId);
      }
      return { status: "done", result: { paid, refused } };
    },
  }),
};
