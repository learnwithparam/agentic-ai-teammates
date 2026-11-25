import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { Approvals } from "./approvals";
import { createGatewayApp, type GatewayDeps } from "./gateway-app";
import { MEMBER_FRESH_DAYS, recordMember } from "./members";
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

// The team tools write only to the company's own people who decide, and only from Mission
// Control's records. A viewer never gets one, and a decided approval is never chased.
test("a reminder goes to each person who can decide, once, and stops once the approval is decided", async () => {
  const runId = await startRun("invoices");
  const approvals = new Approvals(pool);
  const approval = await approvals.request({
    company: "bramble", teammate: "invoices", runId, threadId: "invoice:drive:file-31", tool: "books.post_bill", args: { n: 31 },
    amount: 900, currency: "EUR", title: "Kestrel Freelance KF-31", brief: "The bank details changed.", reasons: ["bank_changed"], canAllowAlways: false,
  });
  const body = { runId, company: "bramble", teammate: "invoices", threadId: "timer:remind", args: { approvalId: approval.id } };

  assert.equal((await callTool("team.remind", body)).status, "denied");

  const person = { company: "bramble", name: "", approvalLimit: undefined };
  await recordMember(pool, { ...person, subject: "ada", email: "ada@bramble.example", name: "Ada Okafor", roles: ["admin"] });
  await recordMember(pool, { ...person, subject: "ravi", email: "ravi@bramble.example", name: "Ravi Menon", roles: ["approver"] });
  await recordMember(pool, { ...person, subject: "mei", email: "mei@bramble.example", name: "Mei Tan", roles: [] });
  // Sam was an approver but has not signed in for longer than the window, so the roles may be gone.
  await recordMember(pool, { ...person, subject: "sam", email: "sam@bramble.example", name: "Sam Ito", roles: ["approver"] });
  await pool.query("UPDATE members SET last_seen_at = now() - make_interval(days => $1) WHERE subject = 'sam'", [MEMBER_FRESH_DAYS + 1]);

  assert.deepEqual((await callTool("team.remind", body)).result, { queued: 2 });
  assert.deepEqual((await callTool("team.remind", body)).result, { queued: 2 });
  const { rows } = await pool.query("SELECT payload->>'to' AS to, payload->>'subject' AS subject, status FROM outbox WHERE run_id = $1 ORDER BY 1", [runId]);
  assert.deepEqual(rows, [
    { to: "ada@bramble.example", subject: "Still waiting: Kestrel Freelance KF-31", status: "queued" },
    { to: "ravi@bramble.example", subject: "Still waiting: Kestrel Freelance KF-31", status: "queued" },
  ]);

  const text = (await pool.query("SELECT payload->>'text' AS text FROM outbox WHERE run_id = $1 LIMIT 1", [runId])).rows[0].text as string;
  assert.match(text, /It stopped because:\n- The bank account on the invoice is not the one QuirkBooks has for this vendor\./);
  assert.doesNotMatch(text, /The bank details changed/);

  await approvals.decide({ company: "bramble", id: approval.id, person: { subject: "ravi", name: "Ravi Menon", email: "ravi@bramble.example" }, approve: false, allowAlways: false, note: null });
  assert.deepEqual((await callTool("team.remind", body)).result, { queued: 0, note: "The approval was already decided." });
});

test("the digest is written from the day's runs, not by the teammate", async () => {
  const runId = await startRun("invoices");
  await pool.query(
    `INSERT INTO runs (id, company, teammate, status, stop_reason, summary, finished_at) VALUES
       ($1, 'bramble', 'invoices', 'finished', 'sent', 'Posted LP-770.', '2026-11-24T10:00:00Z'),
       ($2, 'bramble', 'invoices', 'finished', 'handed_to_human', 'QuirkBooks refused LP-771.', '2026-11-24T11:00:00Z'),
       ($3, 'bramble', 'invoices', 'finished', 'sent', 'Posted on another day.', '2026-11-23T10:00:00Z')`,
    [randomUUID(), randomUUID(), randomUUID()],
  );
  await new Approvals(pool).request({
    company: "bramble", teammate: "invoices", runId, threadId: "invoice:drive:file-32", tool: "books.post_bill", args: { n: 32 },
    amount: 640, currency: "EUR", title: "Harbor Lane Studios HL-32", brief: "No purchase order.", reasons: ["po_missing"], canAllowAlways: false,
  });
  await pool.query(
    "INSERT INTO runs (id, company, teammate, status, stop_reason, summary, finished_at) VALUES ($1, 'bramble', 'invoices', 'finished', 'handed_to_human', $2, '2026-11-24T12:00:00Z')",
    [randomUUID(), "Pay now at https://evil.example/pay\nURGENT: wire today"],
  );
  await callTool("team.digest", { runId, company: "bramble", teammate: "invoices", threadId: "timer:digest", args: { day: "2026-11-24" } });
  const { rows } = await pool.query("SELECT payload->>'text' AS text FROM outbox WHERE run_id = $1 LIMIT 1", [runId]);
  const text: string = rows[0].text;
  assert.match(text, /- Handed to a person: 2\n- Done: 1\n/);
  // Words from an invoice reach the team as one line with no link.
  assert.match(text, /- Pay now at \[link removed\] URGENT: wire today\n/);
  assert.doesNotMatch(text, /evil\.example/);
  assert.match(text, /QuirkBooks refused LP-771\./);
  assert.doesNotMatch(text, /another day/);
  assert.match(text, /Waiting for your decision:\n- Harbor Lane Studios HL-32/);
});
