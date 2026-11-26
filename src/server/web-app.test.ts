import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express, { type Express, type RequestHandler } from "express";
import type { Pool } from "pg";
import { Webhook } from "standardwebhooks";
import { handleErrors } from "../../apps/shared/server";
import * as client from "../client/mission-control/api";
import { Approvals } from "./approvals";
import { say } from "./conversation";
import { Outbox } from "./outbox";
import type { Person } from "./auth";
import { contextualTuples, type Check } from "./permissions";
import { recordSpend } from "./spend";
import { testDatabase } from "./test-database";
import type { NewsShelf } from "./news-shelf";
import { testMemory, testNewsShelf } from "./test-memory";
import { createWebApp } from "./web-app";
import { TEAMMATES } from "./teammates/registry";

// Mission Control's web process against a real Postgres. Signing in is Keycloak's job and has
// its own tests in auth.test.ts; here a test chooses who is signed in. OpenFGA's rules have
// their own tests in infra/openfga/model.fga.yaml; here a test records what was asked.

const secrets = { lmail: `whsec_${randomBytes(24).toString("base64")}`, ldrive: `whsec_${randomBytes(24).toString("base64")}` };
const ADA: Person = { subject: "ada-id", email: "ada@bramble.example", name: "Ada Okafor", company: "bramble", roles: ["admin"] };
const MEI: Person = { subject: "mei-id", email: "mei@bramble.example", name: "Mei Tanaka", company: "bramble", roles: [] };
const RAVI: Person = { subject: "ravi-id", email: "ravi@bramble.example", name: "Ravi Menon", company: "bramble", roles: ["approver"], approvalLimit: 5000 };

let pool: Pool;
let close: () => Promise<void>;
let closeMemory: () => Promise<void>;
let shelf: NewsShelf;
let closeShelf: () => Promise<void>;
let app: Express;
let base: string;
let server: ReturnType<Express["listen"]>;
let signedIn: Person | null = null;
let allow = true;
// Relations this test says no to, while every other question gets the answer in allow.
const refused = new Set<string>();
const asked: { relation: string; object: string; context?: Record<string, number> }[] = [];

const requirePerson: RequestHandler = (request, response, next) => {
  if (!signedIn) {
    response.status(401).json({ error: "Sign in first." });
    return;
  }
  request.person = signedIn;
  next();
};

const check: Check = async (_person, relation, object, context) => {
  asked.push({ relation, object: `${object.type}:${object.id}`, context });
  return allow && !refused.has(relation);
};

before(async () => {
  ({ pool, close } = await testDatabase());
  const { memory, close: emptyMemory } = await testMemory();
  closeMemory = emptyMemory;
  ({ shelf, close: closeShelf } = await testNewsShelf("https://mc.example"));
  app = createWebApp({ pool, check, auth: { router: express.Router(), requirePerson }, hookSecrets: secrets, memory, news: shelf });
  app.use(handleErrors);
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await close();
  await closeMemory();
  await closeShelf();
});
beforeEach(() => {
  signedIn = null;
  allow = true;
  refused.clear();
  asked.length = 0;
});

function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return fetch(`${base}${path}`, { method: init.method ?? "GET", body, headers: { "content-type": "application/json", ...init.headers } });
}

// Every route the app has, read from Express itself, so a new route is covered without a list to keep.
function routes(): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  const walk = (stack: { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } }[]) => {
    for (const layer of stack) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) found.push({ method: method.toUpperCase(), path: layer.route.path });
      else if (layer.handle?.stack) walk(layer.handle.stack as never);
    }
  };
  walk((app as unknown as { router: { stack: never[] } }).router.stack);
  return found;
}

test("every route needs a signed-in person, except the health checks and the signed hooks", async () => {
  const all = routes();
  assert.ok(all.length >= 10, `Found only ${all.length} routes.`);
  for (const route of all) {
    const path = route.path.replace(/:company/g, "bramble").replace(/:tool/g, "mail.reply").replace(/:[a-z]+/gi, randomUUID());
    const response = await call(path, { method: route.method, body: route.method === "GET" ? undefined : {} });
    if (route.path === "/healthz" || route.path === "/readyz") assert.equal(response.status, 200, `${route.path} is not up.`);
    else if (route.path.startsWith("/hooks/")) assert.equal(response.status, 401, `${route.method} ${route.path} took an unsigned notice.`);
    else assert.equal(response.status, 401, `${route.method} ${route.path} answered without a signed-in person.`);
  }
});

test("the news page shows a signed-in person their own company's editions, if they may see the news teammate", async () => {
  const card = { headline: "Canals reopen", bullets: ["One.", "Two.", "Three."], whyItMatters: "Boats run again.", url: "https://example.org/canals", source: "Example News", topic: "Cities" };
  await shelf.publish("bramble", { day: "2026-11-25", publishedAt: "2026-11-25T06:05:00.000Z", cards: [card] });

  assert.equal((await call("/news/data/today.json")).status, 401);
  signedIn = MEI;
  const today = await call("/news/data/today.json");
  assert.equal(today.status, 200);
  assert.equal((await today.json()).cards[0].headline, "Canals reopen");
  assert.deepEqual(asked.at(-1), { relation: "can_view", object: "teammate:bramble-news", context: undefined });
  assert.equal((await call("/news/data/2026-11-01.json")).status, 404);
  assert.equal((await call("/news/data/..%2Fsecrets.json")).status, 404);

  refused.add("can_view");
  assert.equal((await call("/news/data/today.json")).status, 403);
  refused.clear();

  // The page's files are relative to /news/, so the bare address moves there and keeps the day.
  const bare = await fetch(`${base}/news?day=2026-11-25`, { redirect: "manual" });
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get("location"), "/news/?day=2026-11-25");
});

function signed(secret: string, body: string, id = randomUUID()) {
  const now = new Date();
  return { "webhook-id": id, "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": new Webhook(secret).sign(id, now, body) };
}

test("an LMail notice with a bad signature is refused and nothing is stored", async () => {
  const body = JSON.stringify({ emailAddress: "ap@bramble.example", historyId: "41" });
  const response = await call("/hooks/lmail/bramble", { method: "POST", raw: body, headers: signed(secrets.ldrive, body) });
  assert.equal(response.status, 401);
  const { rows } = await pool.query("SELECT 1 FROM inbox_events WHERE payload->>'historyId' = '41'");
  assert.equal(rows.length, 0);
});

test("an LMail notice whose body was changed after signing is refused", async () => {
  const body = JSON.stringify({ emailAddress: "ap@bramble.example", historyId: "42" });
  const headers = signed(secrets.lmail, body);
  const response = await call("/hooks/lmail/bramble", { method: "POST", raw: body.replace("42", "43"), headers });
  assert.equal(response.status, 401);
});

test("a signed LMail notice is stored once, however often it is delivered", async () => {
  const body = JSON.stringify({ emailAddress: "ap@bramble.example", historyId: "44" });
  const headers = signed(secrets.lmail, body);
  const first = await call("/hooks/lmail/bramble", { method: "POST", raw: body, headers });
  const again = await call("/hooks/lmail/bramble", { method: "POST", raw: body, headers });
  assert.equal(first.status, 202);
  assert.equal(again.status, 200);
  const { rows } = await pool.query("SELECT teammate, deliveries FROM inbox_events WHERE payload->>'historyId' = '44'");
  assert.deepEqual(rows, [{ teammate: "invoices", deliveries: 2 }]);
});

test("a signed notice for another company's mailbox is refused", async () => {
  const body = JSON.stringify({ emailAddress: "someone@elsewhere.example", historyId: "45" });
  const response = await call("/hooks/lmail/bramble", { method: "POST", raw: body, headers: signed(secrets.lmail, body) });
  assert.equal(response.status, 422);
});

test("an LDrive notice for a channel Mission Control does not hold is refused", async () => {
  await pool.query(
    `INSERT INTO subscriptions (source, channel_id, token, expires_at) VALUES ('ldrive:bramble', 'channel-1', 'right-token', now() + interval '1 day')
     ON CONFLICT (source) DO UPDATE SET channel_id = 'channel-1', token = 'right-token'`,
  );
  const body = "{}";
  const goog = { "X-Goog-Channel-ID": "channel-1", "X-Goog-Resource-State": "change", "X-Goog-Message-Number": "7" };
  const wrong = await call("/hooks/ldrive/bramble", { method: "POST", raw: body, headers: { ...signed(secrets.ldrive, body), ...goog, "X-Goog-Channel-Token": "wrong-token" } });
  assert.equal(wrong.status, 401);
  const right = await call("/hooks/ldrive/bramble", { method: "POST", raw: body, headers: { ...signed(secrets.ldrive, body), ...goog, "X-Goog-Channel-Token": "right-token" } });
  assert.equal(right.status, 202);
});

async function pendingApproval(amount: number, currency = "EUR") {
  const runId = randomUUID();
  await pool.query("INSERT INTO runs (id, company, teammate) VALUES ($1, 'bramble', 'invoices')", [runId]);
  return new Approvals(pool).request({
    company: "bramble", teammate: "invoices", runId, threadId: `invoice:test:${runId}`, tool: "books.post_bill",
    args: { amount }, amount, currency, title: "Post a bill", brief: "The PO is over tolerance.", reasons: ["po_over_tolerance"], canAllowAlways: false,
  });
}

test("deciding asks OpenFGA with the approval's amount, and a refusal leaves it pending", async () => {
  const approval = await pendingApproval(7200);
  signedIn = RAVI;
  allow = false;
  const refused = await call(`/api/approvals/${approval.id}/decide`, { method: "POST", body: { approve: true } });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "This amount is above what you can approve. Ask an admin." });
  assert.deepEqual(asked, [{ relation: "can_decide", object: `approval:${approval.id}`, context: { amount: 7200 } }]);
  const { rows } = await pool.query("SELECT status FROM approvals WHERE id = $1", [approval.id]);
  assert.equal(rows[0].status, "pending");
});

test("someone who only views is told they cannot decide, not that the amount is too high", async () => {
  const approval = await pendingApproval(300);
  signedIn = MEI;
  allow = false;
  const refused = await call(`/api/approvals/${approval.id}/decide`, { method: "POST", body: { approve: true } });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "You can view approvals, but not decide them." });
});

test("an allowed decision is recorded, audited and wakes the teammate", async () => {
  const approval = await pendingApproval(300);
  signedIn = RAVI;
  const response = await call(`/api/approvals/${approval.id}/decide`, { method: "POST", body: { approve: true } });
  assert.equal(response.status, 200);
  const shown = (await response.json()) as Record<string, unknown>;
  assert.equal(shown.status, "approved");
  assert.equal("decidedBy" in shown, false);
  const events = await pool.query("SELECT type FROM inbox_events WHERE source = 'approval' AND source_id = $1", [approval.id]);
  assert.deepEqual(events.rows, [{ type: "approval.decided" }]);
  const audit = await pool.query("SELECT actor, action FROM audit_log WHERE subject = $1", [approval.id]);
  assert.deepEqual(audit.rows, [{ actor: RAVI.email, action: "approval.approved" }]);
});

test("an approver cannot turn a decision into a standing rule", async () => {
  const approval = await pendingApproval(300);
  signedIn = RAVI;
  refused.add("can_configure");
  const response = await call(`/api/approvals/${approval.id}/decide`, { method: "POST", body: { approve: true, allowAlways: true } });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Only an admin can make this a standing rule." });
  const { rows } = await pool.query("SELECT status FROM approvals WHERE id = $1", [approval.id]);
  assert.equal(rows[0].status, "pending");
});

test("an amount in another currency is an admin's decision, whatever the approver's limit", async () => {
  const approval = await pendingApproval(300, "GBP");
  signedIn = RAVI;
  refused.add("can_configure");
  const response = await call(`/api/approvals/${approval.id}/decide`, { method: "POST", body: { approve: true } });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "An amount in another currency needs an admin." });
  assert.deepEqual(asked.map((question) => question.relation), ["can_configure"]);
  signedIn = ADA;
  refused.clear();
  const decided = await call(`/api/approvals/${approval.id}/decide`, { method: "POST", body: { approve: true } });
  assert.equal(decided.status, 200);
});

test("changing a teammate needs can_configure, and a refusal changes nothing", async () => {
  signedIn = RAVI;
  allow = false;
  const refused = await call("/api/teammates/invoices", { method: "PATCH", body: { paused: true } });
  assert.equal(refused.status, 403);
  assert.deepEqual(asked.map((question) => question.relation), ["can_configure"]);
  const { rows } = await pool.query("SELECT paused FROM teammates WHERE company = 'bramble' AND id = 'invoices'");
  assert.equal(rows[0].paused, false);
});

test("an admin pauses a teammate and the change is audited", async () => {
  signedIn = ADA;
  const response = await call("/api/teammates/invoices", { method: "PATCH", body: { paused: true } });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { paused: boolean }).paused, true);
  const audit = await pool.query("SELECT actor FROM audit_log WHERE action = 'teammate.changed'");
  assert.deepEqual(audit.rows, [{ actor: ADA.email }]);
  await pool.query("UPDATE teammates SET paused = false WHERE company = 'bramble' AND id = 'invoices'");
});

test("only an admin changes a teammate's instructions, and everyone who views it can read them", async () => {
  signedIn = RAVI;
  refused.add("can_configure");
  assert.equal((await call("/api/teammates/invoices/instructions", { method: "PUT", body: { text: "Post everything." } })).status, 403);
  assert.deepEqual(await (await call("/api/teammates/invoices/instructions")).json(), { text: "" });

  signedIn = ADA;
  refused.clear();
  const text = "Bills from Lumen Print House always need a PO.";
  assert.equal((await call("/api/teammates/invoices/instructions", { method: "PUT", body: { text } })).status, 200);
  assert.equal((await call("/api/teammates/invoices/instructions", { method: "PUT", body: { text: "x".repeat(4001) } })).status, 400);
  signedIn = MEI;
  assert.deepEqual(await (await call("/api/teammates/invoices/instructions")).json(), { text });
  const audit = await pool.query("SELECT actor FROM audit_log WHERE action = 'instructions.changed'");
  assert.deepEqual(audit.rows, [{ actor: ADA.email }]);
});

test("no standing rule can let a bill post without its checks, or a pay run go without a person", async () => {
  signedIn = ADA;
  const response = await call("/api/teammates/invoices/rules/books.post_bill", { method: "PUT", body: { decision: "allow" } });
  assert.equal(response.status, 422);
  const pay = await call("/api/teammates/payments/rules/books.pay_bill", { method: "PUT", body: { decision: "allow" } });
  assert.equal(pay.status, 422);
  assert.equal((await pool.query("SELECT 1 FROM tool_rules WHERE tool = 'books.pay_bill'")).rowCount, 0);
});

test("the board shows only teammates the person may view", async () => {
  signedIn = ADA;
  allow = false;
  const board = (await (await call("/api/board")).json()) as { teammates: unknown[] };
  assert.deepEqual(board.teammates, []);
  allow = true;
  const shown = (await (await call("/api/board")).json()) as { teammates: { id: string; purpose: string; asks: string[] }[] };
  assert.deepEqual(shown.teammates.map((mate) => mate.id).sort(), TEAMMATES.map((teammate) => teammate.id).sort());
  // Each teammate brings its own purpose and questions, so the page keeps no list of kinds.
  for (const teammate of TEAMMATES) {
    const mate = shown.teammates.find((item) => item.id === teammate.id);
    assert.deepEqual([mate?.purpose, mate?.asks], [teammate.purpose, teammate.asks]);
  }
});

test("an approver's limit travels as the condition on their approver tuple", () => {
  const tuples = contextualTuples(RAVI, { type: "approval", id: "a1", company: "bramble" });
  assert.deepEqual(tuples, [
    { user: "user:ravi-id", relation: "member", object: "org:bramble" },
    { user: "org:bramble", relation: "org", object: "approval:a1" },
    { user: "user:ravi-id", relation: "approver", object: "org:bramble", condition: { name: "within_limit", context: { limit: 5000 } } },
  ]);
  const viewer = contextualTuples({ ...RAVI, roles: [] }, { type: "teammate", id: "bramble-invoices", company: "bramble" });
  assert.equal(viewer.length, 2);
});

test("a message to a teammate is stored once and queued once, however often it is sent", async () => {
  signedIn = MEI;
  refused.add("can_configure");
  const messageId = randomUUID();
  for (let send = 0; send < 2; send++) {
    const response = await call("/api/teammates/invoices/messages", { method: "POST", body: { messageId, text: "  What waits for me?  " } });
    assert.equal(response.status, 202);
  }
  refused.clear();
  const events = await pool.query("SELECT type, payload FROM inbox_events WHERE source = 'person' AND source_id = $1", [`${MEI.email}/${messageId}`]);
  // Mei only views the teammate, so its answer may use only what the board already shows her.
  // The authority comes from her signed token, so the gateway can act for her only as far as she may.
  const authority = { subject: MEI.subject, name: MEI.name, email: MEI.email, roles: [], approvalLimit: null };
  const payload = { messageId, text: "What waits for me?", from: MEI.name, person: MEI.email, reach: "board", authority };
  assert.deepEqual(events.rows, [{ type: "person.message", payload }]);
  const { lines } = (await (await call("/api/teammates/invoices/conversation")).json()) as { lines: { role: string; text: string; author: string }[] };
  assert.deepEqual(lines.map(({ role, text, author }) => ({ role, text, author })), [{ role: "person", text: "What waits for me?", author: MEI.name }]);

  // Ravi decides bills, so his answer may read with the teammate's tools, under his own limit.
  signedIn = RAVI;
  refused.add("can_configure");
  const raviMessage = randomUUID();
  assert.equal((await call("/api/teammates/news/messages", { method: "POST", body: { messageId: raviMessage, text: "Post Lumen's invoice." } })).status, 202);
  refused.clear();
  const raviEvent = await pool.query("SELECT payload FROM inbox_events WHERE source = 'person' AND source_id = $1", [`${RAVI.email}/${raviMessage}`]);
  assert.equal(raviEvent.rows[0].payload.reach, "tools");
  assert.deepEqual(raviEvent.rows[0].payload.authority, { subject: RAVI.subject, name: RAVI.name, email: RAVI.email, roles: ["approver"], approvalLimit: 5000 });
});

test("only someone who may configure a teammate lets it read the books and mail for an answer", async () => {
  signedIn = ADA;
  const messageId = randomUUID();
  await call("/api/teammates/invoices/messages", { method: "POST", body: { messageId, text: "What are Lumen's bank details?" } });
  const { rows } = await pool.query("SELECT payload->>'reach' AS reach FROM inbox_events WHERE source_id = $1", [`${ADA.email}/${messageId}`]);
  assert.deepEqual(rows, [{ reach: "tools" }]);
});

test("each person sees only their own thread with a teammate", async () => {
  signedIn = RAVI;
  const { lines } = (await (await call("/api/teammates/invoices/conversation")).json()) as { lines: unknown[] };
  assert.deepEqual(lines, []);
});

test("someone who cannot see a teammate can neither write to it nor read its conversation", async () => {
  signedIn = MEI;
  allow = false;
  const messageId = randomUUID();
  assert.equal((await call("/api/teammates/news/messages", { method: "POST", body: { messageId, text: "Hello" } })).status, 403);
  assert.equal((await call("/api/teammates/news/conversation")).status, 403);
  const { rows } = await pool.query("SELECT 1 FROM inbox_events WHERE source_id = $1::text UNION ALL SELECT 1 FROM conversation WHERE message_id = $1::uuid", [messageId]);
  assert.equal(rows.length, 0);
});

test("an empty or overlong message is refused", async () => {
  signedIn = MEI;
  for (const text of ["   ", "x".repeat(2001)]) {
    assert.equal((await call("/api/teammates/invoices/messages", { method: "POST", body: { messageId: randomUUID(), text } })).status, 400);
  }
});

// The page reads every answer with the schemas in src/client/mission-control/api.ts. Parsing a
// real answer here means a change to either side fails this test, not the page in a browser.
test("every answer Mission Control reads matches the shape the page expects", async () => {
  const approval = await pendingApproval(4200);
  // An invoice from LDrive has no sender. The live board once failed to load on exactly that.
  const fromDrive = { kind: "drive", id: "file-1", attachmentId: null, sender: null, subject: "LP-772.pdf", messageId: null };
  await pool.query("UPDATE approvals SET args = args || jsonb_build_object('source', $2::jsonb) WHERE id = $1", [approval.id, JSON.stringify(fromDrive)]);
  const run = approval.runId;
  await pool.query("INSERT INTO run_steps (run_id, kind, title, detail) VALUES ($1, 'check', 'Ran the invoice checks', $2)", [run, JSON.stringify({ failed: ["po_over_tolerance"] })]);
  await recordSpend(pool, { company: "bramble", teammate: "invoices", runId: run, tier: "fast", task: "extract", inputTokens: 900, cachedTokens: 600, outputTokens: 200, costUsd: 0.0012 });
  await new Outbox(pool).add({
    company: "bramble", teammate: "invoices", runId: run, target: "lmail.send", title: "Reply to Lumen", idempotencyKey: `test:${run}`,
    payload: { to: "billing@lumen.example", subject: "Your invoice", text: "Thanks, it is with an approver." }, status: "draft",
  });
  await say(pool, { company: "bramble", teammate: "invoices", person: ADA.email, messageId: randomUUID(), role: "person", author: ADA.name, text: "What are you waiting on?" });
  signedIn = ADA;
  await call("/api/teammates/invoices", { method: "PATCH", body: { paused: false, quiet: true, autoPostLimit: 2000, dailyBudgetUsd: 2 } });

  const read = async <T>(path: string, shape: { parse: (value: unknown) => T }) => {
    const response = await call(path);
    assert.equal(response.status, 200, path);
    return shape.parse(await response.json());
  };
  const board = await read("/api/board", client.Board);
  assert.ok(board.approvals.some((item) => item.id === approval.id));
  assert.ok(board.outbox.some((item) => item.status === "draft"));
  assert.ok(board.spend.length > 0);
  // The run carries the tokens the provider read from its cache, for the run sheet.
  assert.equal(board.runs.find((item) => item.id === run)?.cached_tokens, 600);
  // The draft above is one the teammate wrote and nobody has sent yet.
  assert.ok((board.teammates.find((mate) => mate.id === "invoices")?.volume.waiting ?? 0) >= 1);
  const detail = await read(`/api/runs/${run}`, client.RunDetail);
  assert.ok(detail.steps.length > 0);
  await read("/api/me", client.SignedIn);
  await read("/api/rules", client.Rules);
  assert.ok((await read("/api/audit", client.Audit)).entries.length > 0);
  const { lines } = await read("/api/teammates/invoices/conversation", client.Conversation);
  assert.ok(lines.some((line) => line.text === "What are you waiting on?"));
  await read("/api/teammates/invoices/instructions", client.Instructions);
});
