import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS } from "../src/server/models";
import { modelProblems } from "./check-models";

const live = (id: string, parameters: string[], prompt = "0.00000007", completion = "0.0000002") => ({
  id,
  pricing: { prompt, completion },
  supported_parameters: parameters,
});
const ALL = ["tools", "tool_choice", "structured_outputs", "response_format"];

test("a live model with every need and the written price passes", () => {
  assert.deepEqual(modelProblems("fast", MODELS.fast, [live(MODELS.fast.id, ALL)]), []);
});

test("a model that left the list fails", () => {
  assert.match(modelProblems("fast", MODELS.fast, [])[0], /not on OpenRouter's live list/);
});

test("a model without structured outputs fails", () => {
  const problems = modelProblems("fast", MODELS.fast, [live(MODELS.fast.id, ["tools", "tool_choice", "response_format"])]);
  assert.match(problems.join("\n"), /no longer supports structured_outputs/);
});

test("a price change fails", () => {
  const problems = modelProblems("fast", MODELS.fast, [live(MODELS.fast.id, ALL, "0.0000001")]);
  assert.match(problems.join("\n"), /input price/);
});
