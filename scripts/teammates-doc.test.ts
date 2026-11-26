import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// docs/teammates.md is the reference for every field a teammate and a tool can have. The fields
// are read from the types themselves, so a new field with no row here fails.

const ROOT = path.join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const DOC = read("docs/teammates.md");

// The field names of one exported object type, one per line, as `name:` or `name?:`.
function fieldsOf(source: string, type: string): string[] {
  const start = source.indexOf(`export type ${type}`);
  assert.ok(start >= 0, `no type ${type}`);
  const body = source.slice(source.indexOf("{", start) + 1);
  const fields: string[] = [];
  let depth = 0;
  for (const line of body.split("\n")) {
    if (depth === 0) {
      const field = line.match(/^ {2}(\w+)\??:/);
      if (field) fields.push(field[1]);
      if (/^};/.test(line)) break;
    }
    depth += (line.match(/[{(]/g) ?? []).length - (line.match(/[})]/g) ?? []).length;
  }
  return fields;
}

test("docs/teammates.md has a row for every field of a teammate, its capabilities and a tool", () => {
  const teammate = read("src/server/teammates/define.ts");
  const tool = read("src/server/tools/define.ts");
  const fields = [...fieldsOf(teammate, "TeammateDefinition"), ...fieldsOf(teammate, "Capabilities"), ...fieldsOf(tool, "ToolDefinition")];
  assert.ok(fields.includes("capabilities") && fields.includes("followUps") && fields.includes("guard"), fields.join(", "));
  const missing = fields.filter((field) => !DOC.includes(`| \`${field}\` |`));
  assert.deepEqual(missing, []);
});
