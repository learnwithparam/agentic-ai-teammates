import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import type { GatewayClient, ModelAnswer, RoutedAnswer } from "./gateway-client";
import { CapReached, readCursor, Run, RUN_CAPS } from "./run";
import { testDatabase } from "./test-database";

// A run's limits against a real Postgres. The gateway here answers from a script the test
// writes. So a test can make the model ask for one more tool forever, or cost too much.

let pool: Pool;
let close: () => Promise<void>;

before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());

type Script = { answer: (call: number) => ModelAnswer; toolCalls: string[] };

function scriptedGateway(script: Script): GatewayClient {
  let calls = 0;
  const gateway = {
    async model(): Promise<RoutedAnswer> {
      calls += 1;
      return { tier: "fast", reason: "scripted", answer: script.answer(calls) };
    },
    async tool(_ref: unknown, tool: string) {
      script.toolCalls.push(tool);
      return { status: "done", result: { found: false } };
    },
  };
  return gateway as unknown as GatewayClient;
}

async function startRun(gateway: GatewayClient) {
  return Run.start(pool, gateway, { runId: randomUUID(), company: "bramble", teammate: "invoices" }, RUN_CAPS);
}

async function runRow(id: string) {
  const { rows } = await pool.query("SELECT status, stop_reason, summary, threads FROM runs WHERE id = $1", [id]);
  return rows[0];
}

const lookAgain = (call: number): ModelAnswer => ({
  content: null,
  toolCalls: [{ id: `call-${call}`, name: "books__find_vendor", arguments: JSON.stringify({ name: "Acme" }) }],
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.0001,
});

test("a loop that never answers stops at the step limit and goes to a person", async () => {
  const script: Script = { answer: lookAgain, toolCalls: [] };
  const run = await startRun(scriptedGateway(script));
  const result = await run.toolLoop({
    threadId: "thread-steps", task: "investigate", risk: "high", maxTokens: 500,
    messages: [{ role: "user", content: "Why does this invoice fail?" }], tools: ["books.find_vendor"],
  });
  assert.ok("handed" in result);
  assert.equal(script.toolCalls.length, RUN_CAPS.maxLoopSteps);
  run.outcome("thread-steps", "handed_to_human", result.handed);
  assert.equal(await run.finish(), "handed_to_human");
  const row = await runRow(run.ref.runId);
  assert.equal(row.stop_reason, "handed_to_human");
  const steps = await pool.query("SELECT title FROM run_steps WHERE run_id = $1", [run.ref.runId]);
  assert.ok(steps.rows.some((step) => step.title === "The loop reached its step limit"));
});

test("a run that reaches its dollar limit makes no more calls and keeps its cursors where they were", async () => {
  const expensive = (): ModelAnswer => ({ content: "{}", toolCalls: [], inputTokens: 1000, outputTokens: 1000, costUsd: 0.06 });
  const script: Script = { answer: expensive, toolCalls: [] };
  const run = await startRun(scriptedGateway(script));
  run.advanceCursor("mail", "99");
  const ask = { task: "extract" as const, risk: "low" as const, prior: [], messages: [], maxTokens: 500 };
  await run.model(ask);
  await run.model(ask);
  await assert.rejects(run.model(ask), CapReached);
  await assert.rejects(run.tool("thread-dollars", "books.find_vendor", { name: "Acme" }), CapReached);
  assert.equal(script.toolCalls.length, 0);
  // What the invoice teammate does with a CapReached: hand the thread over and hold the cursors.
  run.outcome("thread-dollars", "handed_to_human", "This run spent its 0.1 dollars.");
  run.holdCursors();
  assert.equal(await run.finish(), "handed_to_human");
  assert.equal(await readCursor(pool, "bramble", "invoices", "mail"), null);
  assert.equal((await runRow(run.ref.runId)).summary, "This run spent its 0.1 dollars.");
});

test("a run that reaches its token limit stops the same way", async () => {
  const big = (): ModelAnswer => ({ content: "{}", toolCalls: [], inputTokens: RUN_CAPS.maxTokens, outputTokens: 1, costUsd: 0.001 });
  const run = await startRun(scriptedGateway({ answer: big, toolCalls: [] }));
  const ask = { task: "extract" as const, risk: "low" as const, prior: [], messages: [], maxTokens: 500 };
  await run.model(ask);
  await assert.rejects(run.model(ask), CapReached);
});

test("the stop reason is the outcome a person most needs to see", async () => {
  const run = await startRun(scriptedGateway({ answer: lookAgain, toolCalls: [] }));
  run.outcome("a", "sent", "Posted one bill.");
  run.outcome("b", "deferred", "One bill waits for approval.");
  run.outcome("c", "handed_to_human", "One invoice could not be read.");
  run.advanceCursor("mail", "120");
  assert.equal(await run.finish(), "handed_to_human");
  const row = await runRow(run.ref.runId);
  assert.deepEqual(row.threads, ["a", "b", "c"]);
  assert.equal(await readCursor(pool, "bramble", "invoices", "mail"), "120");
});

test("a failed run saves no cursor", async () => {
  const run = await startRun(scriptedGateway({ answer: lookAgain, toolCalls: [] }));
  run.advanceCursor("drive", "55");
  assert.equal(await run.finish("LMail did not answer."), "failed");
  assert.equal(await readCursor(pool, "bramble", "invoices", "drive"), null);
});
