import { attacks } from "./attacks";
import { DIGEST, defineTeammate, TIDY } from "../define";
import { invoiceTeammate } from "./work";

export const invoice = defineTeammate({
  kind: "invoice",
  id: "invoices",
  name: "Invoice teammate",
  purpose: "Reads every invoice that reaches the accounts mailbox or the Invoices folder, and posts the ones that check out.",
  asks: ["What are you waiting on?", "Why did the last invoice stop?", "Which vendors need a purchase order?"],
  tools: [
    "mail.history",
    "mail.message",
    "mail.search",
    "mail.attachment_text",
    "mail.reply",
    "drive.changes",
    "drive.file_text",
    "books.find_vendor",
    "books.purchase_order",
    "books.vendor_bills",
    "books.post_bill",
    "memory.read",
    "memory.reported",
    "memory.record_decision",
    "memory.note",
    "memory.progress",
    "memory.report",
    "memory.propose_tidy",
    "team.remind",
    "team.digest",
    "team.follow_up",
    "team.hand_over",
  ],
  schedules: [DIGEST, TIDY],
  listens: ["mail", "drive"],
  defaults: { dailyBudgetUsd: 1 },
  capabilities: {
    // A person may ask it to look at something later, or hand it a bill to post, so chat acts.
    chat: { mode: "act", reads: ["books.find_vendor", "books.purchase_order", "books.vendor_bills", "mail.search", "mail.message", "drive.changes"] },
    followUps: true,
    digest: true,
    // Its vendor notes grow with every invoice, so once a week it proposes shorter ones.
    tidy: true,
  },
  evaluate: "data/invoices/run.ts",
  attacks,
  work: invoiceTeammate,
});
