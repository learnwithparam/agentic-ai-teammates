import assert from "node:assert/strict";
import { test } from "node:test";
import { breakItProblems, expectProblems, hasFailurePath, readmeProblems, shapeProblems } from "./lessons";

const files: Record<string, string> = {
  "src/server/env.ts": "export function setting() {}",
  "src/server/env.test.ts": 'test("an empty value counts as missing", () => {});',
  "docs/images/board.png": "png",
};
const read = (path: string) => files[path] ?? null;

const page = `# Start the stack

## Why
Text.

## Goal
Text.

## Starting point
Text.

## How it works
\`\`\`mermaid
sequenceDiagram
  A->>B: ask
  B-->>A: refused, no key
\`\`\`
![The board](../images/board.png)

## Run it
Text.

## Break it
Change \`src/server/env.ts\`. Run \`src/server/env.test.ts\`: "an empty value counts as missing" fails.

## What you have now
Text.
`;

test("a page with every part in order has no problems", () => {
  assert.deepEqual(shapeProblems("docs/learner/start.md", page, read), []);
});

test("a bash block with no Expect line after it is caught", () => {
  assert.deepEqual(expectProblems("x.md", "```bash\nnpm test\n```\n\nExpect: it passes."), []);
  assert.match(expectProblems("x.md", "```bash\nnpm test\n```\n\nThen it passes.").join("\n"), /needs an "Expect:" line/);
});

test("a page with its headings out of order is caught", () => {
  const swapped = page.replace("## Goal", "## Tmp").replace("## Why", "## Goal").replace("## Tmp", "## Why");
  assert.match(shapeProblems("docs/learner/start.md", swapped, read).join("\n"), /in order/);
});

test("a happy-path-only sequence diagram is caught", () => {
  assert.equal(hasFailurePath("sequenceDiagram\n  A->>B: ask\n  B-->>A: answer"), false);
  assert.equal(hasFailurePath("sequenceDiagram\n  A->>B: ask\n  alt no key\n  B-->>A: x\n  end"), true);
});

test("a break-it that quotes a test no file holds is caught", () => {
  const problems = breakItProblems("x.md", 'Change `src/server/env.ts`. Run `src/server/env.test.ts`: "a test that was renamed" fails.', read);
  assert.match(problems.join("\n"), /no named test file holds/);
});

test("a break-it that names a missing file is caught", () => {
  const problems = breakItProblems("x.md", 'Change `src/server/gone.ts`. Run `src/server/env.test.ts`: "an empty value counts as missing".', read);
  assert.match(problems.join("\n"), /gone\.ts, which does not exist/);
});

test("a break-it that says to find a line the file no longer holds is caught", () => {
  const section = 'Open `src/server/env.ts` and find `a line that was refactored away`. Run `src/server/env.test.ts`: "an empty value counts as missing".';
  assert.match(breakItProblems("x.md", section, read).join("\n"), /which no named file holds/);
  const real = 'Open `src/server/env.ts` and find `export function setting`. Run `src/server/env.test.ts`: "an empty value counts as missing".';
  assert.doesNotMatch(breakItProblems("x.md", real, read).join("\n"), /which no named file holds/);
});

test("a missing image is caught", () => {
  assert.match(shapeProblems("docs/learner/start.md", page.replace("board.png", "gone.png"), read).join("\n"), /image .*gone\.png/);
});

test("the README links each lesson once, by its own title", () => {
  const pages = [{ file: "docs/learner/start.md", page }];
  assert.deepEqual(readmeProblems("| [Start the stack](./docs/learner/start.md) |", pages), []);
  assert.match(readmeProblems("| [Setup](./docs/learner/start.md) |", pages).join("\n"), /its title is/);
});
