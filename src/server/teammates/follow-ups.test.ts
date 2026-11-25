import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { conversation, say } from "../conversation";
import type { GatewayClient, ModelAsk, RoutedAnswer } from "../gateway-client";
import type { InboxEvent } from "../inbox";
import { Run, RUN_CAPS } from "../run";
import { testDatabase } from "../test-database";
import { handleFollowUps } from "./follow-ups";
import { invoice } from "./invoice/teammate";
import { news } from "./news/teammate";

// A follow-up the teammate set for itself fires against a real Postgres. The gateway answers from
// a script and keeps reported.md in a set, so the test sees what was read, told and kept.

let pool: Pool;
let close: () => Promise<void>;

before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());

const RAVI = "ravi@bramble.example";

function gateway(asks: ModelAsk[], calls: { tool: string; args: Record<string, unknown> }[], reported: Set<string>): GatewayClient {
  return {
    async model(_ref: unknown, ask: ModelAsk): Promise<RoutedAnswer> {
      asks.push(ask);
      return { tier: "fast", reason: "scripted", answer: { content: "Lumen has not replied yet.", toolCalls: [], inputTokens: 200, outputTokens: 20, costUsd: 0.0001 } };
    },
    async tool(_ref: unknown, tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });
      if (tool === "memory.read") return { status: "done", result: { text: args.path === "progress/lumen-bank-check.md" ? "- Asked Lumen to confirm." : null } };
      if (tool === "memory.report") {
        const line = `${args.person}: ${args.line}`;
        const added = !reported.has(line);
        reported.add(line);
        return { status: "done", result: { added } };
      }
      return { status: "done", result: { added: true } };
    },
  } as unknown as GatewayClient;
}

function fired(eventId = randomUUID()): InboxEvent {
  return {
    id: eventId, company: "bramble", teammate: "invoices", source: "timer", sourceId: `follow:${eventId}`, type: "timer.fired",
    payload: { name: `follow:${eventId}`, about: "Lumen's reply", reason: "Ravi asked on Monday.", person: RAVI, task: "lumen-bank-check" },
    deliveries: 1, attempts: 0, receivedAt: new Date(),
  };
}

test("a follow-up reads its progress, tells the person once, and keeps a line of progress", async () => {
  await say(pool, { company: "bramble", teammate: "invoices", person: RAVI, messageId: randomUUID(), role: "person", author: "Ravi", text: "Check Lumen's reply on Friday." });
  const asks: ModelAsk[] = [];
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const reported = new Set<string>();
  const other: InboxEvent = { ...fired(), type: "mail.received", source: "mail", payload: {} };
  const run = await Run.start(pool, gateway(asks, calls, reported), { runId: randomUUID(), company: "bramble", teammate: "invoices" }, RUN_CAPS);
  assert.deepEqual(await handleFollowUps(run, [fired(), other], invoice), [other]);
  assert.match(String(asks[0].messages.at(-1)?.content), /Asked Lumen to confirm/);
  assert.ok(calls.some((call) => call.tool === "memory.progress" && call.args.task === "lumen-bank-check"));
  const told = () => conversation(pool, "bramble", "invoices", RAVI).then((lines) => lines.filter((line) => line.role === "teammate" && line.text === "Lumen has not replied yet."));
  assert.equal((await told()).length, 1);
  // The same finding a second time is kept quiet: reported.md already has it.
  const again = await Run.start(pool, gateway(asks, calls, reported), { runId: randomUUID(), company: "bramble", teammate: "invoices" }, RUN_CAPS);
  await handleFollowUps(again, [fired()], invoice);
  assert.equal((await told()).length, 1);
});

test("a teammate that does not set follow-ups hands one back instead of acting on it", async () => {
  const asks: ModelAsk[] = [];
  const run = await Run.start(pool, gateway(asks, [], new Set()), { runId: randomUUID(), company: "bramble", teammate: "news" }, RUN_CAPS);
  assert.deepEqual(await handleFollowUps(run, [fired()], news), []);
  assert.equal(asks.length, 0);
});
