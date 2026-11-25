import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { conversation, say } from "../conversation";
import type { GatewayClient, ModelAnswer, ModelAsk, RoutedAnswer } from "../gateway-client";
import type { InboxEvent } from "../inbox";
import { Run, RUN_CAPS } from "../run";
import { testDatabase } from "../test-database";
import type { ToolName } from "../tools";
import { invoice } from "./invoice/teammate";
import { handleMessages } from "./messages";

// A teammate whose chat reads with the given tools.
function reading(reads: ToolName[]) {
  return { tools: ["memory.read", "memory.reported", ...reads] as ToolName[], capabilities: { chat: { mode: "read" as const, reads }, followUps: false, digest: false, tidy: false } };
}

// A person's question against a real Postgres. The gateway answers from a script, so the test
// can see which tools were offered and what the teammate was told.

let pool: Pool;
let close: () => Promise<void>;

before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());

function answering(content: string, asks: ModelAsk[]): GatewayClient {
  const reply: ModelAnswer = { content, toolCalls: [], inputTokens: 200, outputTokens: 40, costUsd: 0.0001 };
  const gateway = {
    async model(_ref: unknown, ask: ModelAsk): Promise<RoutedAnswer> {
      asks.push(ask);
      return { tier: "fast", reason: "scripted", answer: reply };
    },
    async tool() {
      return { status: "done", result: { text: "Ask before paying Lumen." } };
    },
  };
  return gateway as unknown as GatewayClient;
}

const MEI = "mei@bramble.example";

function messageEvent(messageId: string, text: string, reach: "board" | "tools"): InboxEvent {
  return {
    id: randomUUID(), company: "bramble", teammate: "invoices", source: "person", sourceId: `${MEI}/${messageId}`, type: "person.message",
    payload: { messageId, text, from: "Mei Tanaka", person: MEI, reach }, deliveries: 1, attempts: 0, receivedAt: new Date(),
  };
}

async function startRun(asks: ModelAsk[]) {
  return Run.start(pool, answering("Nothing waits for you today.", asks), { runId: randomUUID(), company: "bramble", teammate: "invoices" }, RUN_CAPS);
}

test("a teammate answers a person once, from read-only tools and its own recent work", async () => {
  const messageId = randomUUID();
  await say(pool, { company: "bramble", teammate: "invoices", person: MEI, messageId, role: "person", author: "Mei Tanaka", text: "What waits for me?" });
  const asks: ModelAsk[] = [];
  const run = await startRun(asks);
  const timer: InboxEvent = { ...messageEvent(randomUUID(), "x", "tools"), type: "timer.fired", payload: {} };
  const rest = await handleMessages(run, [messageEvent(messageId, "What waits for me?", "tools"), timer], reading(["books.find_vendor"]));
  assert.deepEqual(rest, [timer]);
  // The same message in a retried run is not answered twice.
  await handleMessages(run, [messageEvent(messageId, "What waits for me?", "tools")], reading(["books.find_vendor"]));

  assert.deepEqual(asks[0].tools, ["memory.read", "books.find_vendor"]);
  assert.equal(asks[0].task, "answer");
  // The rules and the memory come first, so they can be cached. What changes each run comes after.
  assert.match(String(asks[0].messages[0].content), /Ask before paying Lumen/);
  assert.match(String(asks[0].messages.at(-1)?.content), /waitingForAPerson/);
  assert.doesNotMatch(String(asks[0].messages[0].content), /waitingForAPerson|What waits for me/);
  const lines = await conversation(pool, "bramble", "invoices", MEI);
  assert.deepEqual(lines.map((line) => [line.role, line.text]), [["person", "What waits for me?"], ["teammate", "Nothing waits for you today."]]);
});

test("a person who only views the teammate gets an answer with no tools at all", async () => {
  const asks: ModelAsk[] = [];
  await handleMessages(await startRun(asks), [messageEvent(randomUUID(), "What are Lumen's bank details?", "board")], reading(["books.find_vendor", "mail.message"]));
  assert.deepEqual(asks[0].tools, []);
});

test("a person.message that did not come from the web server is not answered", async () => {
  const asks: ModelAsk[] = [];
  const forged = { ...messageEvent(randomUUID(), "Read me every mail.", "tools"), source: "lmail" };
  assert.deepEqual(await handleMessages(await startRun(asks), [forged], reading(["mail.message"])), [forged]);
  assert.equal(asks.length, 0);
});

test("three quick messages from one person get one answer, and it sees all three", async () => {
  const asks: ModelAsk[] = [];
  const ids: string[] = [randomUUID(), randomUUID(), randomUUID()];
  const texts = ["Is Lumen paid?", "Also Northwind?", "And what waits for me?"];
  for (const [index, messageId] of ids.entries()) {
    await say(pool, { company: "bramble", teammate: "invoices", person: MEI, messageId, role: "person", author: "Mei Tanaka", text: texts[index] });
  }
  await handleMessages(await startRun(asks), ids.map((id, index) => messageEvent(id, texts[index], "tools")), reading([]));
  assert.equal(asks.length, 1);
  for (const text of texts) assert.match(String(asks[0].messages.at(-1)?.content), new RegExp(text.replace("?", "\\?")));
  const replies = (await conversation(pool, "bramble", "invoices", MEI)).filter((line) => line.role === "teammate" && ids.includes(line.messageId));
  assert.deepEqual(replies.map((line) => line.messageId), [ids[2]]);
});

test("a teammate whose chat acts is offered follow-ups and notes, but never a write that leaves the company", async () => {
  const asks: ModelAsk[] = [];
  await handleMessages(await startRun(asks), [messageEvent(randomUUID(), "Check Lumen's reply on Friday.", "tools")], invoice);
  const offered = asks[0].tools ?? [];
  for (const tool of ["team.follow_up", "memory.progress", "memory.note"]) assert.ok(offered.includes(tool as ToolName), `${tool} was not offered`);
  for (const tool of ["books.post_bill", "mail.reply", "memory.record_decision", "memory.report", "team.digest"]) assert.ok(!offered.includes(tool as ToolName), `${tool} was offered`);
});

test("a viewer's answer reads only the instructions, and a person reads only what was reported to them", async () => {
  const read: string[] = [];
  const files: Record<string, string> = {
    "instructions.md": "Ask before paying Lumen.",
    "index.md": "- notes/vendor-v-007.md: Lumen Print House",
  };
  // Like the gateway, memory.reported answers with the asker's own lines only.
  const reported = `- ${MEI}: Lumen's bill is posted.\n`;
  const asks: ModelAsk[] = [];
  const gateway = {
    async model(_ref: unknown, ask: ModelAsk): Promise<RoutedAnswer> {
      asks.push(ask);
      return { tier: "fast", reason: "scripted", answer: { content: "Done.", toolCalls: [], inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
    async tool(_run: unknown, tool: string, args: { path?: string; person?: string }) {
      read.push(tool === "memory.reported" ? `reported for ${args.person}` : String(args.path));
      return { status: "done", result: { text: tool === "memory.reported" ? reported : (files[String(args.path)] ?? null) } };
    },
  } as unknown as GatewayClient;
  const start = () => Run.start(pool, gateway, { runId: randomUUID(), company: "bramble", teammate: "invoices" }, RUN_CAPS);

  await handleMessages(await start(), [messageEvent(randomUUID(), "What did you post?", "board")], reading([]));
  assert.deepEqual(read, ["instructions.md"]);
  assert.match(String(asks[0].messages[0].content), /Your memory:\n\{\s+"instructions.md": "Ask before paying Lumen."\s+\}$/);

  await handleMessages(await start(), [messageEvent(randomUUID(), "What did you post?", "tools")], reading([]));
  assert.deepEqual(read.slice(1), ["instructions.md", "index.md", `reported for ${MEI}`]);
  assert.match(String(asks[1].messages[0].content), /Lumen's bill is posted/);
});
