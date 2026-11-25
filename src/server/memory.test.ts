import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Memory, NOTE_LINES, notePath, vendorTopic } from "./memory";
import { testMemory } from "./test-memory";

// Memory against a real S3. A note keeps each line once and only its newest lines, and nothing
// outside a teammate's own folder can be named.

let memory: Memory;
let close: () => Promise<void>;
const scope = { company: "bramble", teammate: "invoices" };

before(async () => {
  ({ memory, close } = await testMemory());
});
after(async () => close());

test("a file a teammate never wrote reads as nothing", async () => {
  assert.equal(await memory.read(scope, "instructions.md"), null);
  assert.equal(await memory.read(scope, notePath("vendor-nobody")), null);
});

test("a note keeps each line once, and only its newest lines", async () => {
  assert.deepEqual(await memory.addLine(scope, "vendor-lumen", "Ravi approved LP-1."), { added: true });
  assert.deepEqual(await memory.addLine(scope, "vendor-lumen", "Ravi  approved\nLP-1."), { added: false });
  for (let line = 2; line <= NOTE_LINES + 5; line += 1) await memory.addLine(scope, "vendor-lumen", `Line ${line}.`);
  const lines = (await memory.read(scope, notePath("vendor-lumen")))!.trim().split("\n");
  assert.equal(lines.length, NOTE_LINES);
  assert.equal(lines.at(-1), `- Line ${NOTE_LINES + 5}.`);
  assert.ok(!lines.includes("- Ravi approved LP-1."));
});

test("each teammate reads only its own folder, and no path leaves it", async () => {
  await memory.setInstructions(scope, "Bills from Lumen always need a PO.");
  assert.equal(await memory.read({ company: "bramble", teammate: "news" }, "instructions.md"), null);
  for (const path of ["notes/../instructions.md", "secrets.env", "notes/Vendor.md", "../bramble/news/instructions.md"]) {
    await assert.rejects(memory.read(scope, path), /is not a memory file/);
  }
  await assert.rejects(memory.read({ company: "bramble", teammate: "../news" }, "instructions.md"), /cannot name a memory folder/);
  await assert.rejects(memory.setInstructions(scope, "x".repeat(4001)), /at most/);
});

test("a vendor's note is named from its name, whatever the invoice wrote", () => {
  assert.equal(vendorTopic("Lumen Print House"), "vendor-lumen-print-house");
  assert.equal(vendorTopic("Café Ünder / ../etc"), "vendor-cafe-under-etc");
  assert.equal(vendorTopic("!!!"), "vendor-unnamed");
  assert.equal(notePath(vendorTopic("x".repeat(200))), `notes/vendor-${"x".repeat(55)}.md`);
});
