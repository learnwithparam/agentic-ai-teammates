import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express, { type Express, type RequestHandler } from "express";
import type { Pool } from "pg";
import { Webhook } from "standardwebhooks";
import { handleErrors } from "../../apps/shared/server";
import { Approvals } from "./approvals";
import type { Person } from "./auth";
import { contextualTuples, type Check } from "./permissions";
import { testDatabase } from "./test-database";
import { createWebApp } from "./web-app";

// Mission Control's web process against a real Postgres. Signing in is Keycloak's job and has
// its own tests in auth.test.ts; here a test chooses who is signed in. OpenFGA's rules have
// their own tests in infra/openfga/model.fga.yaml; here a test records what was asked.

const secrets = { lmail: `whsec_${randomBytes(24).toString("base64")}`, ldrive: `whsec_${randomBytes(24).toString("base64")}` };
const ADA: Person = { subject: "ada-id", email: "ada@bramble.example", name: "Ada Okafor", company: "bramble", roles: ["admin"] };
const RAVI: Person = { subject: "ravi-id", email: "ravi@bramble.example", name: "Ravi Menon", company: "bramble", roles: ["approver"], approvalLimit: 5000 };

let pool: Pool;
let close: () => Promise<void>;
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
  app = createWebApp({ pool, check, auth: { router: express.Router(), requirePerson }, hookSecrets: secrets });
  app.use(handleErrors);
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await close();
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

test("every route needs a signed-in person, except the health check and the signed hooks", async () => {
  const all = routes();
  assert.ok(all.length >= 10, `Found only ${all.length} routes.`);
  for (const route of all) {
    const path = route.path.replace(/:company/g, "bramble").replace(/:tool/g, "mail.reply").replace(/:[a-z]+/gi, randomUUID());
    const response = await call(path, { method: route.method, body: route.method === "GET" ? undefined : {} });
    if (route.path === "/healthz") assert.equal(response.status, 200);
    else if (route.path.startsWith("/hooks/")) assert.equal(response.status, 401, `${route.method} ${route.path} took an unsigned notice.`);
    else assert.equal(response.status, 401, `${route.method} ${route.path} answered without a signed-in person.`);
  }
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
  assert.deepEqual(asked, [{ relation: "can_decide", object: `approval:${approval.id}`, context: { amount: 7200 } }]);
  const { rows } = await pool.query("SELECT status FROM approvals WHERE id = $1", [approval.id]);
  assert.equal(rows[0].status, "pending");
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
  const { rows } = await pool.query("SELECT status FROM approvals WHERE id = $1", [approval.id]);
  assert.equal(rows[0].status, "pending");
});

test("an amount in another currency is an admin's decision, whatever the approver's limit", async () => {
  const approval = await pendingApproval(300, "GBP");
  signedIn = RAVI;
  refused.add("can_configure");
  const response = await call(`/api/approvals/${approval.id}/decide`, { method: "POST", body: { approve: true } });
  assert.equal(response.status, 403);
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

test("no standing rule can let a bill post without its checks", async () => {
  signedIn = ADA;
  const response = await call("/api/teammates/invoices/rules/books.post_bill", { method: "PUT", body: { decision: "allow" } });
  assert.equal(response.status, 422);
});

test("the board shows only teammates the person may view", async () => {
  signedIn = ADA;
  allow = false;
  const board = (await (await call("/api/board")).json()) as { teammates: unknown[] };
  assert.deepEqual(board.teammates, []);
  allow = true;
  const shown = (await (await call("/api/board")).json()) as { teammates: { id: string }[] };
  assert.deepEqual(shown.teammates.map((mate) => mate.id).sort(), ["invoices", "news"]);
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
