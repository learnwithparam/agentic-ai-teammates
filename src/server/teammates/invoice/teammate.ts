import { DIGEST, defineTeammate } from "../define";
import { invoiceTeammate } from "./work";

export const invoice = defineTeammate({
  kind: "invoice",
  id: "invoices",
  name: "Invoice teammate",
  purpose: "Reads every invoice that reaches the accounts mailbox or the Invoices folder, and posts the ones that check out.",
  tools: [
    "mail.history",
    "mail.message",
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
    "team.remind",
    "team.digest",
    "team.follow_up",
    "team.hand_over",
  ],
  schedules: [DIGEST],
  listens: ["mail", "drive"],
  defaults: { dailyBudgetUsd: 1 },
  capabilities: {
    // A person may ask it to look at something later, or hand it a bill to post, so chat acts.
    chat: { mode: "act", reads: ["books.find_vendor", "books.purchase_order", "books.vendor_bills", "mail.history", "mail.message", "drive.changes"] },
    followUps: true,
    digest: true,
  },
  work: invoiceTeammate,
});
