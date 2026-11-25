import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { Approvals } from "./approvals";
import { createGatewayApp, type GatewayDeps } from "./gateway-app";
import { setRule } from "./policy";
import { testDatabase } from "./test-database";

// The gateway's writing tools against a real Postgres. A standing rule a person sets must hold
// for every writing tool. Publishing the news once ignored it and went straight to the outbox.

let pool: Pool;
let close: () => Promise<void>;
let server: Server;
let base: string;
const WORKER = randomUUID();

// These tests reach only the policy and the outbox. Anything else the gateway is asked for fails loudly.
function unreachable(name: string): never {
  throw new Error(`The gateway tests do not reach ${name}.`);
}

before(async () => {
  ({ pool, close } = await testDatabase());
  const deps: GatewayDeps = {
    pool,
    callModel: async () => unreachable("a model"),
    mail: () => unreachable("LMail"),
    files: new Proxy({}, { get: () => unreachable("LDrive") }) as GatewayDeps["files"],
    books: new Proxy({}, { get: () => unreachable("QuirkBooks") }) as GatewayDeps["books"],
    publisher: null,
    tokens: { worker: WORKER, dispatcher: randomUUID() },
  };
  server = createGatewayApp(deps).listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The gateway did not start.");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.close();
  await close();
});

const NEWS = {
  day: "2026-11-25",
  cards: [
    {
      headline: "A city opens its bus data",
      bullets: ["The data is live.", "It covers every route.", "Anyone can use it."],
      whyItMatters: "Riders can see delays as they happen.",
      url: "https://example.org/buses",
      source: "Example News",
      topic: "Cities",
    },
  ],
};

async function startRun(teammate: string) {
  const runId = randomUUID();
  await pool.query("INSERT INTO runs (id, company, teammate) VALUES ($1, 'bramble', $2)", [runId, teammate]);
  return runId;
}

async function callTool(tool: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${WORKER}` },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function outboxFor(runId: string) {
  const { rows } = await pool.query("SELECT target, status FROM outbox WHERE run_id = $1", [runId]);
  return rows;
}

test("with no rule set, the news goes to the outbox", async () => {
  const runId = await startRun("news");
  const result = await callTool("news.publish", { runId, company: "bramble", teammate: "news", threadId: "news:a", args: NEWS });
  assert.equal(result.status, "done");
  assert.equal((await outboxFor(runId)).length, 1);
});

test("a standing rule to approve the news makes it wait for a person, with nothing in the outbox", async () => {
  await setRule(pool, { company: "bramble", teammate: "news", tool: "news.publish", decision: "approve", setBy: "ada@bramble.example" });
  try {
    const runId = await startRun("news");
    const day = { ...NEWS, day: "2026-11-26" };
    const result = await callTool("news.publish", { runId, company: "bramble", teammate: "news", threadId: "news:b", args: day });
    assert.equal(result.status, "needs_approval");
    assert.deepEqual(await outboxFor(runId), []);

    // Once a person approves, the same call publishes once. A second try with that approval is refused.
    await new Approvals(pool).decide({
      company: "bramble", id: result.approvalId, approve: true, allowAlways: false, note: null,
      person: { subject: "ada", name: "Ada", email: "ada@bramble.example" },
    });
    const approved = { runId, company: "bramble", teammate: "news", threadId: "news:b", args: day, approvalId: result.approvalId };
    assert.equal((await callTool("news.publish", approved)).status, "done");
    assert.equal((await callTool("news.publish", approved)).status, "denied");
    assert.deepEqual(await outboxFor(runId), [{ target: "github.publish", status: "queued" }]);
  } finally {
    await pool.query("DELETE FROM tool_rules WHERE teammate = 'news'");
  }
});
