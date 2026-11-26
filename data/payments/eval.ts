import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createPool, migrate } from "../../src/server/db";
import { requireSettings, setting } from "../../src/server/env";
import { GatewayClient } from "../../src/server/gateway-client";
import { DueBillSchema, payProblems, runTotal } from "../../src/server/payments";
import { COMPANIES } from "../../src/server/people";
import { Run } from "../../src/server/run";

// Scores the payments teammate's checks against the live books, through the gateway. A pay run
// calls no model, so the eval asks two plain questions. Is each seeded bill judged the way the
// books say? Does the gateway refuse every run that should never reach a person?
// It never pays: every run it sends is one the gateway must refuse.
//
//   npm run teammate:eval -- payments
//
// It fails when a check disagrees with the books, or when a bad run gets an approval card.

requireSettings(["DATABASE_URL", "GATEWAY_URL", "GATEWAY_WORKER_TOKEN"]);

// Its own teammate, off duty, like the other evals.
const EVAL_TEAMMATE = "payments-eval";
const COMPANY = "bramble";
const CURRENCY = COMPANIES[COMPANY].currency;
const TODAY = new Date().toISOString().slice(0, 10);

// The bills QuirkBooks seeds, and whether a pay run may pay each one while it is open.
const SEEDED = [
  { id: "3a1c9e7b-5d2f-4b8a-9c6e-1f0d2b4a6c02", payable: true },
  { id: "5b7f0c2e-9d1a-4e3b-8c6f-2a4d1e7b9c01", payable: true },
  { id: "4b2d0f8c-6e3a-4c9b-8d7f-2a1e3c5b7d03", payable: false },
];
const CHANGED_BANK = SEEDED[2].id;

const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);
await pool.query(
  "INSERT INTO teammates (company, id, kind, name, on_duty) VALUES ($1, $2, 'payments', 'Payments eval', false) ON CONFLICT (company, id) DO UPDATE SET paused = false, on_duty = false",
  [COMPANY, EVAL_TEAMMATE],
);
const gateway = new GatewayClient(setting("GATEWAY_URL"), setting("GATEWAY_WORKER_TOKEN"));
const run = await Run.start(pool, gateway, { runId: randomUUID(), company: COMPANY, teammate: EVAL_TEAMMATE });
const thread = `eval:payments:${TODAY}`;

let failed = false;
function row(right: boolean, name: string, said: string) {
  if (!right) failed = true;
  console.log(`  ${right ? "ok  " : "MISS"} ${name.padEnd(44)} ${said}`);
}

const found = await run.tool(thread, "books.due_bills", { day: TODAY, withinDays: 31 });
if (found.status !== "done") throw new Error(`The gateway did not list the bills: ${found.status}.`);
const bills = z.object({ bills: z.array(DueBillSchema) }).parse(found.result).bills;

console.log("\nchecks against the books");
for (const seeded of SEEDED) {
  const bill = bills.find((each) => each.id === seeded.id);
  // A seeded bill a person already paid is no longer due, so there is nothing to judge.
  if (!bill) {
    row(seeded.payable, `bill ${seeded.id.slice(0, 8)}`, seeded.payable ? "already paid, skipped" : "missing: it must stay open");
    continue;
  }
  const problems = payProblems(bill, CURRENCY);
  row(problems.length === 0 === seeded.payable, `${bill.vendor} ${bill.invoiceNumber}`, problems.length ? `held: ${problems.join(" ")}` : "may be paid");
}

console.log("\nruns the gateway must refuse");
const payable = bills.filter((bill) => payProblems(bill, CURRENCY).length === 0);
const refusals = [
  { name: "a run with the changed bank", args: { billIds: [...payable.map((bill) => bill.id), CHANGED_BANK], total: runTotal(bills) } },
  { name: "a run whose total is lower than its bills", args: { billIds: payable.map((bill) => bill.id), total: 1 } },
  { name: "a run in another currency", args: { billIds: payable.map((bill) => bill.id), total: runTotal(payable), currency: "USD" } },
];
for (const refusal of refusals) {
  // With no bill left to pay, only the changed-bank run still means anything.
  if (refusal.args.billIds.length === 0) continue;
  const said = await run.tool(thread, "books.pay_bill", { day: TODAY, currency: CURRENCY, ...refusal.args });
  row(said.status === "denied", refusal.name, said.status === "denied" ? `refused: ${said.reason}` : `got ${said.status}`);
}

run.outcome(thread, failed ? "handed_to_human" : "nothing_to_send", "Payments eval");
await run.finish();
await pool.end();
if (failed) {
  console.error("\nA payments check disagreed with the books, or a bad pay run reached a person.");
  process.exit(1);
}
