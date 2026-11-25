import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { invoiceGraph } from "./graph";

// LangGraph checks a graph's shape only when it is built, which the type checker cannot see.
// A node that shares a name with a state field once stopped the worker at start.
test("the invoice graph builds, with every step the plan names", async () => {
  const graph = invoiceGraph(new MemorySaver(), () => {
    throw new Error("Building the graph runs no step.");
  });
  const steps = Object.keys((await graph.getGraphAsync()).nodes).filter((name) => !name.startsWith("__"));
  assert.deepEqual(steps.sort(), ["checks", "extract", "fetch", "investigate", "lookup", "notify", "post", "post_approved", "recall", "screen", "wait", "write_brief"]);
});
