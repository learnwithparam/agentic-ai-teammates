import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";

// Every instruction a model reads lives in a prompts/*.md file, loaded through prompt(). So a
// prompt string left in the code, a file nothing loads, or a load of a missing file fails here.

const SERVER = dirname(new URL(import.meta.url).pathname);

function walk(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const code = walk(SERVER).filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
const files = walk(SERVER).filter((path) => path.endsWith(".md") && dirname(path).endsWith("prompts"));

test("no model instructions are written in the code, and every prompt file is loaded", () => {
  const loaded = new Set<string>();
  for (const path of code) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /_RULES = `/, `${relative(SERVER, path)} writes a prompt in the code; move it to prompts/`);
    for (const [, name] of text.matchAll(/prompt\(import\.meta\.url, "([a-z-]+)"\)/g)) {
      const file = join(dirname(path), "prompts", `${name}.md`);
      assert.ok(existsSync(file), `${relative(SERVER, path)} loads ${name}.md, which does not exist`);
      loaded.add(file);
    }
  }
  for (const file of files) assert.ok(loaded.has(file), `${relative(SERVER, file)} is never loaded`);
  assert.ok(files.length >= 14);
});
