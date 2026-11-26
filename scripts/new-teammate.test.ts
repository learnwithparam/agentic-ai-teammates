import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { addToRegistry, camel, templateFiles } from "./new-teammate";

const REGISTRY = readFileSync(path.join(import.meta.dirname, "../src/server/teammates/registry.ts"), "utf8");

test("a new teammate gets one import and one name in the registry, and a kind is never added twice", () => {
  const added = addToRegistry(REGISTRY, "late-fees");
  assert.match(added, /^import \{ lateFees \} from "\.\/late-fees\/teammate";$/m);
  assert.match(added, /\[invoice, news, payments, lateFees\]/);
  assert.throws(() => addToRegistry(added, "late-fees"), /already lists lateFees/);
});

test("the template writes every file the registry test asks of a teammate", () => {
  assert.equal(camel("late-fees"), "lateFees");
  const files = Object.keys(templateFiles("late-fees"));
  for (const file of ["teammate.ts", "work.ts", "graph.ts", "attacks.ts", "graph.test.ts"]) {
    assert.ok(files.includes(`src/server/teammates/late-fees/${file}`), file);
  }
  assert.ok(files.includes("data/late-fees/eval.ts"));
});
