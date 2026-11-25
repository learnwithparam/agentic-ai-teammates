import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import type { Pool } from "pg";
import { GatewayError, type GatewayClient } from "../gateway-client";
import type { InboxEvent } from "../inbox";
import { Run, RUN_CAPS } from "../run";
import { testDatabase } from "../test-database";
import { invoiceGraph } from "./invoice-graph";
import { invoiceTeammate } from "./invoice";

// A person approved a bill, then the worker died while it posted. The decision comes again on
// the retry, and the thread must finish. A live run once dropped it as "not waiting".

let pool: Pool;
let close: () => Promise<void>;

before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());

const THREAD = "invoice:drive:file-119";
const APPROVAL = randomUUID();
const REFUSED_THREAD = "invoice:drive:file-771";
const REFUSED_APPROVAL = randomUUID();
const INVOICE = {
  vendorName: "Kestrel Freelance", vendorEmail: null, invoiceNumber: "KF-119", invoiceDate: "2026-11-20", dueDate: null,
  currency: "EUR", iban: null, poNumber: null, lines: [{ description: "Design work", quantity: 1, unitPrice: 900, amount: 900 }], tax: 0, total: 900,
};

// The gateway answers the post from a script: the first post dies like a killed process.
function postingGateway(posts: string[]): GatewayClient {
  const gateway = {
    async tool(_ref: unknown, tool: string, _args: unknown, approvalId?: string) {
      posts.push(`${tool}:${approvalId}`);
      if (posts.length === 1) throw new Error("The worker stopped mid-post.");
      return { status: "done", result: { posted: true, billId: "bill-1" } };
    },
  };
  return gateway as unknown as GatewayClient;
}

function decided(approvalId = APPROVAL, threadId = THREAD): InboxEvent {
  return {
    id: "1", source: "approval", sourceId: approvalId, type: "approval.decided", deliveries: 1, attempts: 1, receivedAt: new Date(),
    payload: { approvalId, threadId, status: "approved" },
  } as InboxEvent;
}

// Puts a thread where a real one stops: posted for approval, waiting for a person.
async function waitingThread(checkpointer: MemorySaver, threadId: string, approvalId: string) {
  const setup = invoiceGraph(checkpointer, () => {
    throw new Error("Setting up the thread runs no step.");
  });
  const config = { configurable: { thread_id: threadId } };
  await setup.updateState(
    config,
    {
      source: { kind: "drive", id: threadId, attachmentId: null, sender: null, subject: "invoice.pdf", messageId: null },
      body: null, text: "invoice", invoice: INVOICE, facts: null, reasons: ["unknown_vendor"], findings: null, brief: "New vendor.",
      approvalId, decision: null, posted: false, result: null,
    },
    "post",
  );
  return { setup, config };
}

test("an approved bill whose post died part way posts on the retry and the thread finishes", async () => {
  const checkpointer = new MemorySaver();
  // Put the thread where a real one stops: posted for approval, waiting for a person.
  const setup = invoiceGraph(checkpointer, () => {
    throw new Error("Setting up the thread runs no step.");
  });
  const config = { configurable: { thread_id: THREAD } };
  await setup.updateState(
    config,
    {
      source: { kind: "drive", id: "file-119", attachmentId: null, sender: null, subject: "KF-119.pdf", messageId: null },
      body: null, text: "invoice", invoice: INVOICE, facts: null, reasons: ["unknown_vendor"], findings: null, brief: "New vendor.",
      approvalId: APPROVAL, decision: null, posted: false, result: null,
    },
    "post",
  );
  assert.deepEqual((await setup.getState(config)).next, ["wait"]);

  const posts: string[] = [];
  const work = invoiceTeammate(checkpointer);
  const gateway = postingGateway(posts);

  const first = await Run.start(pool, gateway, { runId: randomUUID(), company: "bramble", teammate: "invoices" }, RUN_CAPS);
  await assert.rejects(work(first, [decided()]), /stopped mid-post/);
  assert.deepEqual((await setup.getState(config)).next, ["post_approved"]);

  const retry = await Run.start(pool, gateway, { runId: randomUUID(), company: "bramble", teammate: "invoices" }, RUN_CAPS);
  await work(retry, [decided()]);
  assert.equal(await retry.finish(), "sent");
  assert.deepEqual(posts, [`books.post_bill:${APPROVAL}`, `books.post_bill:${APPROVAL}`]);
  assert.deepEqual((await setup.getState(config)).next, []);
});

test("a bill QuirkBooks refuses after approval goes to a person once, and is not retried", async () => {
  const checkpointer = new MemorySaver();
  const { setup, config } = await waitingThread(checkpointer, REFUSED_THREAD, REFUSED_APPROVAL);
  let posts = 0;
  const gateway = {
    async tool() {
      posts += 1;
      throw new GatewayError(422, "QuirkBooks answered 422: The lines and tax do not add up to the total.", false);
    },
  } as unknown as GatewayClient;

  const run = await Run.start(pool, gateway, { runId: randomUUID(), company: "bramble", teammate: "invoices" }, RUN_CAPS);
  await invoiceTeammate(checkpointer)(run, [decided(REFUSED_APPROVAL, REFUSED_THREAD)]);
  assert.equal(await run.finish(), "handed_to_human");
  assert.equal(posts, 1);
  assert.deepEqual((await setup.getState(config)).next, []);
});
