import assert from "node:assert/strict";
import { test } from "node:test";
import { openRouterOptions } from "./llm";

// The fast model ignores a reasoning effort. Given even "low", it thought until max_tokens and
// sent cut-off JSON, so every quick check failed over to the strong tier.
test("the fast tier is asked not to think, so its answers are never cut off", () => {
  assert.deepEqual(openRouterOptions("fast").reasoning, { enabled: false });
});

test("no tier is sent a temperature, and every call reports its cost", () => {
  for (const tier of ["fast", "strong"] as const) {
    const options = openRouterOptions(tier);
    assert.equal("temperature" in options, false);
    assert.deepEqual(options.usage, { include: true });
  }
});
