import assert from "node:assert/strict";
import { test } from "node:test";
import { problemsIn } from "./readable";

test("an abbreviated name fails", () => {
  assert.match(problemsIn("a.ts", "const msg = 1;")[0].message, /abbreviation/);
});

test("a two-letter name fails, a whole word passes", () => {
  assert.equal(problemsIn("a.ts", "const xs = 1;").length, 1);
  assert.deepEqual(problemsIn("a.ts", "const invoices = 1;"), []);
});

test("a long sentence across comment lines fails", () => {
  const words = Array.from({ length: 30 }, () => "word").join(" ");
  const text = `// ${words.slice(0, 60)}\n// ${words.slice(60)}.\nconst invoices = 1;`;
  assert.match(problemsIn("a.ts", text)[0].message, /sentence has/);
});

test("a hard word fails", () => {
  assert.match(problemsIn("a.ts", "// We leverage the queue.")[0].message, /hard word/);
});
