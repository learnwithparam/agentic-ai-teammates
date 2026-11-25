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
    "memory.record_decision",
    "team.remind",
    "team.digest",
  ],
  schedules: [DIGEST],
  listens: ["mail", "drive"],
  defaults: { dailyBudgetUsd: 1 },
  work: invoiceTeammate,
});
