import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_TASKS, route, STRONG_CALL_ESTIMATE_USD, STRONG_TASKS, type Task } from "./router";

const plenty = 1;

test("every quick task goes to fast, every heavy task to strong", () => {
  for (const task of FAST_TASKS) assert.equal(route(task, "high", plenty).tier, "fast", task);
  for (const task of STRONG_TASKS) assert.equal(route(task, "low", plenty).tier, "strong", task);
});

test("a schema failure or an error on fast goes to strong", () => {
  assert.equal(route("extract", "low", plenty, [{ tier: "fast", result: "schema_failure" }]).tier, "strong");
  assert.equal(route("extract", "low", plenty, [{ tier: "fast", result: "error" }]).tier, "strong");
});

test("low confidence goes to strong only when the risk is high", () => {
  assert.equal(route("classify", "high", plenty, [{ tier: "fast", result: "low_confidence" }]).tier, "strong");
  assert.equal(route("classify", "low", plenty, [{ tier: "fast", result: "low_confidence" }]).tier, "fast");
});

test("a failure on strong goes to a person", () => {
  const decision = route("investigate", "high", plenty, [{ tier: "strong", result: "schema_failure" }]);
  assert.equal(decision.tier, null);
  assert.match(decision.reason, /a person takes it/);
});

test("a budget too small for strong goes to a person, but quick work still runs", () => {
  const short = STRONG_CALL_ESTIMATE_USD / 2;
  assert.equal(route("select", "low", short).tier, null);
  assert.equal(route("screen", "low", short).tier, "fast");
  assert.equal(route("select", "low", STRONG_CALL_ESTIMATE_USD).tier, "strong");
});

test("the eval setups pin one tier", () => {
  assert.equal(route("investigate", "high", plenty, [], "fast-only").tier, "fast");
  assert.equal(route("extract", "low", plenty, [{ tier: "fast", result: "schema_failure" }], "fast-only").tier, null);
  assert.equal(route("screen", "low", plenty, [], "strong-only").tier, "strong");
});

test("an unknown task is refused", () => {
  assert.throws(() => route("guess" as Task, "low", plenty), /Unknown task/);
});

test("a reason never names a model", () => {
  for (const task of [...FAST_TASKS, ...STRONG_TASKS]) {
    assert.doesNotMatch(route(task, "low", plenty).reason, /nemotron|gpt|luna|openai|nvidia/i);
  }
});
