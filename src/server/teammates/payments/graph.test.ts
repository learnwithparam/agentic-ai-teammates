import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Command, MemorySaver } from "@langchain/langgraph";
import type { Pool } from "pg";
import type { GatewayClient } from "../../gateway-client";
import type { DueBill } from "../../payments";
import { Run, RUN_CAPS } from "../../run";
import { testDatabase } from "../../test-database";
import { FRESH_STATE, paymentsGraph } from "./graph";

// One pay day through the real graph. The gateway answers from a script, so the test can see
// exactly which bills the person was asked to approve and which were paid.

let pool: Pool;
let close: () => Promise<void>;
before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());

const SAME_BANK = "IE29AIBK93115212345678";
const bill = (id: string, invoiceNumber: string, total: number, vendorIban: string): DueBill => ({
  id, vendorId: "V-004", vendor: "Harbor Lane Studios", invoiceNumber, dueDate: "2026-11-28", currency: "EUR", total, status: "open",
  payToIban: SAME_BANK, vendorIban,
});
const DUE = [
  bill("3a1c9e7b-5d2f-4b8a-9c6e-1f0d2b4a6c02", "HL-2026-11", 1500, SAME_BANK),
  bill("5b7f0c2e-9d1a-4e3b-8c6f-2a4d1e7b9c01", "PF-8812", 588, SAME_BANK),
  bill("4b2d0f8c-6e3a-4c9b-8d7f-2a1e3c5b7d03", "HL-2026-10", 420, "ES9121000418450200051332"),
];

type Call = { tool: string; args: { billIds?: string[]; total?: number }; approvalId?: string };

function scripted(calls: Call[]): GatewayClient {
  return {
    async model() {
      throw new Error("A pay run never calls a model.");
    },
    async tool(_ref: unknown, tool: string, args: Call["args"], approvalId?: string) {
      calls.push({ tool, args, approvalId });
      if (tool === "books.due_bills") return { status: "done", result: { bills: DUE } };
      if (!approvalId) return { status: "needs_approval", approvalId: "A-1" };
      return { status: "done", result: { paid: args.billIds, refused: [] } };
    },
  } as unknown as GatewayClient;
}

async function start(calls: Call[], day: string) {
  const runId = randomUUID();
  const run = await Run.start(pool, scripted(calls), { runId, company: "bramble", teammate: "payments" }, RUN_CAPS);
  const graph = paymentsGraph(new MemorySaver(), () => run, () => "EUR");
  const config = { configurable: { thread_id: `payments:${day}`, run_id: runId } };
  await graph.invoke({ day, ...FRESH_STATE }, config);
  return { graph, config };
}

test("a pay run asks once for the bills that may be paid, holds the changed bank, and pays after approval", async () => {
  const calls: Call[] = [];
  const { graph, config } = await start(calls, "2026-11-26");
  const asked = calls.filter((call) => call.tool === "books.pay_bill");
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].args.billIds, [DUE[0].id, DUE[1].id]);
  assert.equal(asked[0].args.total, 2088);
  assert.deepEqual((await graph.getState(config)).next, ["wait"]);

  const state = await graph.invoke(new Command({ resume: { status: "approved", approvalId: "A-1" } }), config);
  assert.equal(calls.at(-1)?.approvalId, "A-1");
  assert.equal(state.result?.outcome, "handed_to_human");
  const note = state.result!.note;
  assert.ok(note.startsWith("Paid 2 of 2 bills for 2026-11-26, 2088.00 EUR"), note);
  assert.ok(note.includes(`Held back: Harbor Lane Studios ${DUE[2].invoiceNumber}`), note);
});

test("a pay run a person turns down pays nothing", async () => {
  const calls: Call[] = [];
  const { graph, config } = await start(calls, "2026-11-27");
  const state = await graph.invoke(new Command({ resume: { status: "denied", approvalId: "A-1" } }), config);
  assert.equal(state.result?.outcome, "nothing_to_send");
  assert.equal(calls.filter((call) => call.approvalId).length, 0);
});
