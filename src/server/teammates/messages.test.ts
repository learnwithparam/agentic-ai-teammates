import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { conversation, say } from "../conversation";
import type { GatewayClient, ModelAnswer, ModelAsk, RoutedAnswer } from "../gateway-client";
import type { InboxEvent } from "../inbox";
import { Run, RUN_CAPS } from "../run";
import { testDatabase } from "../test-database";
import { handleMessages } from "./messages";

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

function messageEvent(messageId: string, text: string): InboxEvent {
  return {
    id: randomUUID(), company: "bramble", teammate: "invoices", source: "person", sourceId: messageId, type: "person.message",
    payload: { messageId, text, from: "Mei Tanaka" }, deliveries: 1, attempts: 0, receivedAt: new Date(),
  };
}

test("a teammate answers a person once, from read-only tools and its own recent work", async () => {
  const messageId = randomUUID();
  await say(pool, { company: "bramble", teammate: "invoices", messageId, role: "person", author: "Mei Tanaka", text: "What waits for me?" });
  const asks: ModelAsk[] = [];
  const run = await Run.start(pool, answering("Nothing waits for you today.", asks), { runId: randomUUID(), company: "bramble", teammate: "invoices" }, RUN_CAPS);
  const timer: InboxEvent = { ...messageEvent(randomUUID(), "x"), type: "timer.fired", payload: {} };
  const rest = await handleMessages(run, [messageEvent(messageId, "What waits for me?"), timer], ["books.find_vendor"]);
  assert.deepEqual(rest, [timer]);
  // The same message in a retried run is not answered twice.
  await handleMessages(run, [messageEvent(messageId, "What waits for me?")], ["books.find_vendor"]);

  assert.deepEqual(asks[0].tools, ["memory.read", "books.find_vendor"]);
  assert.equal(asks[0].task, "answer");
  const told = asks[0].messages.at(-1)?.content ?? "";
  assert.match(String(told), /Ask before paying Lumen/);
  assert.match(String(told), /waitingForAPerson/);
  const lines = await conversation(pool, "bramble", "invoices");
  assert.deepEqual(lines.map((line) => [line.role, line.text]), [["person", "What waits for me?"], ["teammate", "Nothing waits for you today."]]);
});
