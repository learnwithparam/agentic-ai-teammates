import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import type { Pool } from "pg";
import type { GatewayClient } from "../../gateway-client";
import type { InboxEvent } from "../../inbox";
import { Run, RUN_CAPS } from "../../run";
import { testDatabase } from "../../test-database";
import { PAY_RUN_TIMER, paymentsTeammate } from "./work";

// A day's pay run runs once. A second firing on the same day pays nothing.
// It says so in the run, so an empty run is never a mystery.

let pool: Pool;
let close: () => Promise<void>;
before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());

const tools: string[] = [];
const gateway = {
  async model() {
    throw new Error("A pay run never calls a model.");
  },
  async tool(_ref: unknown, tool: string) {
    tools.push(tool);
    if (tool === "books.due_bills") return { status: "done", result: { bills: [] } };
    return { status: "done", result: {} };
  },
} as unknown as GatewayClient;

const fired = (firedFor: string): InboxEvent => ({
  id: randomUUID(), company: "bramble", teammate: "payments", source: "timer", sourceId: randomUUID(),
  type: "timer.fired", payload: { name: PAY_RUN_TIMER, firedFor }, deliveries: 1, attempts: 0, receivedAt: new Date(),
});

async function runOnce(work: ReturnType<typeof paymentsTeammate>, firedFor: string) {
  const run = await Run.start(pool, gateway, { runId: randomUUID(), company: "bramble", teammate: "payments" }, RUN_CAPS);
  await work(run, [fired(firedFor)]);
  const { rows } = await pool.query<{ title: string }>("SELECT title FROM run_steps WHERE run_id = $1", [run.ref.runId]);
  return rows.map((row) => row.title);
}

test("a second pay-run firing on the same day reads no bills and writes why it stopped", async () => {
  const work = paymentsTeammate(new MemorySaver());
  await runOnce(work, "2026-11-26T08:00:00.000Z");
  const first = tools.length;
  assert.ok(first > 0, "the first firing reads the due bills");
  const titles = await runOnce(work, "2026-11-26T09:30:00.000Z");
  assert.equal(tools.length, first, "the second firing calls no tool");
  assert.ok(titles.includes("The pay run for 2026-11-26 already ran, so it does not run again"), titles.join(" | "));
});
