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

test("a vendor's note is named by its QuirkBooks id, never by what the invoice wrote", () => {
  assert.equal(vendorTopic("V-001"), "vendor-v-001");
  assert.throws(() => vendorTopic("../V-001"), /is not a note name/);
  assert.throws(() => vendorTopic("Lumen Print House"), /is not a note name/);
});

test("a new note gets one line in the index, and a task's progress is its own file", async () => {
  const own = { company: "bramble", teammate: "index-check" };
  await memory.addLine(own, "vendor-v-001", "Lumen said the new bank is real.");
  await memory.addLine(own, "vendor-v-001", "Ravi called them.");
  await memory.addLine(own, "vendor-v-002", "Northwind pays late.");
  assert.equal(await memory.read(own, "index.md"), "- notes/vendor-v-001.md\n- notes/vendor-v-002.md\n");
  assert.deepEqual(await memory.addProgress(own, "lumen-bank-check", "Asked Lumen to confirm."), { added: true });
  assert.equal(await memory.read(own, "progress/lumen-bank-check.md"), "- Asked Lumen to confirm.\n");
  await assert.rejects(memory.read(own, "progress/../index.md"), /is not a memory file/);
});

test("a teammate never tells a person the same thing twice", async () => {
  const own = { company: "bramble", teammate: "report-check" };
  assert.deepEqual(await memory.report(own, "ravi@bramble.example", "Lumen has not replied."), { added: true });
  assert.deepEqual(await memory.report(own, "ravi@bramble.example", "Lumen  has not replied."), { added: false });
  // The same words to another person are a new report.
  assert.deepEqual(await memory.report(own, "ada@bramble.example", "Lumen has not replied."), { added: true });
});
