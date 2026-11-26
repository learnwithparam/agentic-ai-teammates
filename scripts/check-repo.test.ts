import assert from "node:assert/strict";
import { test } from "node:test";
import { findProblems } from "./check-repo";

const HOOKS_ON = "git config core.hooksPath .githooks || true";
const manifest = JSON.stringify({ engines: { node: ">=26" }, dependencies: { zod: "4.6.7" }, scripts: { prepare: HOOKS_ON } });
const HOOK = "#!/bin/sh\nif ! npm run check; then\n  exit 1\nfi\n";
const BASE: [string, string][] = [["package.json", manifest], [".node-version", "24.22.3\n"], [".githooks/pre-push", HOOK]];

function problemsFor(extra: Record<string, string>) {
  const files = new Map<string, string>([...BASE, ...Object.entries(extra)]);
  return findProblems(files, [...files.keys()]);
}

test("a push to main must run the gate first", () => {
  assert.deepEqual(problemsFor({}), []);
  const without = new Map(BASE.filter(([path]) => path !== ".githooks/pre-push"));
  assert.match(findProblems(without, [...without.keys()]).join("\n"), /\.githooks\/pre-push: missing/);
  assert.match(problemsFor({ ".githooks/pre-push": "#!/bin/sh\nnpm run check || true\n" }).join("\n"), /does not stop the push/);
  const noPrepare = JSON.stringify({ engines: { node: ">=26" }, dependencies: { zod: "4.6.7" }, scripts: {} });
  assert.match(problemsFor({ "package.json": noPrepare }).join("\n"), /prepare script must run "git config core\.hooksPath \.githooks"/);
});

test("a stand-in word in app code fails", () => {
  const problems = problemsFor({ "src/server/model.ts": "export const reply = 'a canned answer';" });
  assert.match(problems.join("\n"), /src\/server\/model\.ts: says "canned"/);
});

test("a stand-in word in a test file is allowed", () => {
  assert.deepEqual(problemsFor({ "src/server/model.test.ts": "// a fake clock" }), []);
});

test("reading process.env outside env.ts fails", () => {
  const problems = problemsFor({ "src/server/worker.ts": "const key = process.env.OPENROUTER_API_KEY;" });
  assert.match(problems.join("\n"), /worker\.ts: reads process\.env/);
  assert.deepEqual(problemsFor({ "src/server/env.ts": "const key = process.env.OPENROUTER_API_KEY;" }), []);
});

test("a range version fails", () => {
  const files = new Map([["package.json", JSON.stringify({ dependencies: { zod: "^4.6.7" } })], [".node-version", "24.22.3\n"]]);
  assert.match(findProblems(files, [...files.keys()]).join("\n"), /Pin an exact version/);
});

test("CI that sets up Node from a range fails, and the exact pin passes", () => {
  const workflow = (line: string) => `jobs:\n  check:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          ${line}\n`;
  const ranged = problemsFor({ ".github/workflows/check.yml": workflow("node-version-file: package.json") });
  assert.match(ranged.join("\n"), /check\.yml: sets up Node with "node-version-file: package\.json"/);
  assert.match(problemsFor({ ".github/workflows/check.yml": workflow("node-version: 24") }).join("\n"), /"node-version: 24"/);
  assert.deepEqual(problemsFor({ ".github/workflows/check.yml": workflow("node-version-file: .node-version") }), []);
  const loose = findProblems(new Map([["package.json", manifest], [".node-version", "24\n"]]), ["package.json", ".node-version"]);
  assert.match(loose.join("\n"), /\.node-version: says "24"/);
});

test("a script nothing calls fails", () => {
  const problems = problemsFor({ "scripts/orphan.ts": "console.log(1);" });
  assert.match(problems.join("\n"), /scripts\/orphan\.ts: nothing in use/);
});

test("a compose file without its own project name fails", () => {
  const unnamed = problemsFor({ "langfuse/docker-compose.yml": "services:\n  web:\n    image: langfuse/langfuse:3\n" });
  assert.match(unnamed.join("\n"), /langfuse\/docker-compose\.yml: has no "name: teammates-/);
  assert.deepEqual(problemsFor({ "langfuse/docker-compose.yml": "name: teammates-langfuse\nservices:\n  web:\n    image: langfuse/langfuse:3\n" }), []);
});

test("a colour written outside the one stylesheet fails", () => {
  const problems = problemsFor({ "src/client/mission-control/Spend.tsx": 'const bar = { fill: "#257de0" };' });
  assert.match(problems.join("\n"), /Spend\.tsx: writes the colour "#257de0"/);
  assert.match(problemsFor({ "src/client/mission-control/Board.tsx": 'style={{ color: "rgb(0 0 0)" }}' }).join("\n"), /writes the colour "rgb\("/);
  assert.deepEqual(problemsFor({ "src/client/styles/app.css": "--chart-1: #257de0;" }), []);
});
