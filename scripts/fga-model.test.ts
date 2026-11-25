import assert from "node:assert/strict";
import { test } from "node:test";
import { testModel } from "./fga-model";

// The permission rules' own tests, run by the pinned OpenFGA CLI. Change "amount <= limit" to
// "amount >= limit" in infra/openfga/model.fga and this fails.
test("the permission rules pass their own tests", () => {
  const { ok, output } = testModel();
  assert.ok(ok, `OpenFGA model tests failed:\n${output}`);
  assert.match(output, /Tests (\d+)\/\1 passing/);
});
