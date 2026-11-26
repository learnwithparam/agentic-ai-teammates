import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { CARD_WAITS } from "../../checks";
import { invoiceGraph, postResult } from "./graph";

// LangGraph checks a graph's shape only when it is built, which the type checker cannot see.
// A node that shares a name with a state field once stopped the worker at start.
test("the invoice graph builds, with every step the plan names", async () => {
  const graph = invoiceGraph(new MemorySaver(), () => {
    throw new Error("Building the graph runs no step.");
  });
  const steps = Object.keys((await graph.getGraphAsync()).nodes).filter((name) => !name.startsWith("__"));
  assert.deepEqual(steps.sort(), ["ask_payments", "checks", "extract", "fetch", "investigate", "lookup", "notify", "post", "post_approved", "recall", "screen", "wait", "write_brief"]);
});

// A second mail with a bill whose card already waits is not work for a person: they have the card.
test("a bill whose card already waits ends with nothing to send, and any other refusal goes to a person", () => {
  const state = { invoice: { vendorName: "Lumen Print House", invoiceNumber: "LP-120" } } as Parameters<typeof postResult>[0];
  const waits = postResult(state, { status: "denied", reason: `${CARD_WAITS}: Lumen Print House LP-120.` });
  assert.equal(waits.result?.outcome, "nothing_to_send");
  assert.equal(postResult(state, { status: "denied", reason: "QuirkBooks has no such vendor." }).result?.outcome, "handed_to_human");
});
