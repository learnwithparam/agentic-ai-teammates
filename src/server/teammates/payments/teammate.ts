import { attacks } from "./attacks";
import { DIGEST, defineTeammate } from "../define";
import { PAY_RUN_TIMER, paymentsTeammate } from "./work";

export const payments = defineTeammate({
  kind: "payments",
  id: "payments",
  name: "Payments teammate",
  purpose: "Pays the bills that fall due, once a person approves the run, and never to a bank account that changed.",
  asks: ["Which bills fall due this week?", "Why did you hold a bill back?"],
  tools: ["books.due_bills", "books.pay_bill", "memory.read", "memory.reported", "team.remind", "team.digest"],
  // The pay run at nine on a working morning, and the day's summary in the evening.
  schedules: [{ name: PAY_RUN_TIMER, cron: "0 9 * * 1-5", label: "Pay run" }, DIGEST],
  listens: [],
  // Its pay run calls no model, so its budget only pays for chat.
  defaults: { dailyBudgetUsd: 0.25 },
  // It answers questions about the bills that are due, and never sets work for itself.
  capabilities: { chat: { mode: "read", reads: ["books.due_bills"] }, followUps: false, digest: true, tidy: false },
  evaluate: "data/payments/eval.ts",
  attacks,
  work: paymentsTeammate,
});
