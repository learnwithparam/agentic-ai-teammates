import express, { type Express, type RequestHandler, type Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { createApp, HttpError } from "../../apps/shared/server";
import { Approvals } from "./approvals";
import { conversation, MAX_MESSAGE, say } from "./conversation";
import type { Person } from "./auth";
import { createHooksRouter } from "./hooks";
import { Inbox } from "./inbox";
import { Outbox } from "./outbox";
import { COMPANIES } from "./people";
import type { Check } from "./permissions";
import { rules, setRule } from "./policy";
import { spendByDay } from "./spend";
import { isToolName, TOOLS } from "./tools";
import { INSTRUCTIONS, MAX_INSTRUCTIONS, type Memory } from "./memory";

// Mission Control's web process: the signed webhook handlers, and the API behind the board.
// Every API route needs a signed-in person; only /healthz and /hooks/* do not, and the hooks
// check a signature instead. Who may decide or configure is asked of OpenFGA on each request.

export type WebDeps = {
  pool: Pool;
  check: Check;
  auth: { router: Router; requirePerson: RequestHandler };
  hookSecrets: { lmail: string; ldrive: string };
  memory: Memory;
};

const TeammateId = z.string().min(1).max(100);
const Decide = z.object({
  approve: z.boolean(),
  allowAlways: z.boolean().default(false),
  note: z.string().max(500).nullable().default(null),
});
const Instructions = z.object({ text: z.string().max(MAX_INSTRUCTIONS) });
const Release = z.object({ send: z.boolean() });
const TeammateSettings = z
  .object({
    paused: z.boolean(),
    quiet: z.boolean(),
    autoPostLimit: z.number().min(0).max(1_000_000),
    dailyBudgetUsd: z.number().min(0).max(100),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Send at least one setting.");
// The page makes the message id, so sending the same message twice stores it once.
const MessageText = z.string().trim().min(1).max(MAX_MESSAGE);
const Message = z.object({ messageId: z.uuid(), text: MessageText });
const Rule = z.object({ decision: z.enum(["allow", "classify", "approve"]).nullable() });

export function createWebApp(deps: WebDeps): Express {
  const { pool, check } = deps;
  const approvals = new Approvals(pool);
  const outbox = new Outbox(pool);
  const inbox = new Inbox(pool);
  const app = createApp("mission-control");

  // The hooks read their own raw body to check its signature, so they come before express.json.
  app.use(createHooksRouter({ pool, inbox, secrets: deps.hookSecrets }));
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/auth", deps.auth.router);
  app.use("/api", deps.auth.requirePerson);

  const person = (request: express.Request): Person => request.person!;

  function mayTeammate(who: Person, teammate: string, relation: "can_view" | "can_configure") {
    return check(who, relation, { type: "teammate", id: `${who.company}-${teammate}`, company: who.company });
  }

  async function requireTeammate(who: Person, teammate: string, relation: "can_view" | "can_configure", refusal?: string) {
    const { rows } = await pool.query("SELECT 1 FROM teammates WHERE company = $1 AND id = $2", [who.company, teammate]);
    if (!rows[0]) throw new HttpError(404, "There is no such teammate.");
    if (!(await mayTeammate(who, teammate, relation))) {
      throw new HttpError(403, refusal ?? (relation === "can_view" ? "You cannot see this teammate." : "Only an admin can change this teammate."));
    }
  }

  // OpenFGA decides; the roles only choose the words. Someone who only views is not told about a limit.
  function decideRefusal(who: Person): string {
    const decides = who.roles.includes("approver") || who.roles.includes("admin");
    return decides ? "This amount is above what you can approve. Ask an admin." : "You can view approvals, but not decide them.";
  }

  app.get("/api/me", (request, response) => {
    const { name, email, company, roles, approvalLimit } = person(request);
    response.json({ name, email, company, roles, approvalLimit: approvalLimit ?? null });
  });

  // Everything the board shows, in one call: the roster, the four columns and the spend chart.
  app.get("/api/board", async (request, response) => {
    const who = person(request);
    const company = who.company;
    const mates = await pool.query(
      `SELECT mate.id, mate.kind, mate.name, mate.paused, mate.quiet, mate.auto_post_limit, mate.daily_budget_usd,
         (SELECT count(*) FROM inbox_events event WHERE event.company = mate.company AND event.teammate = mate.id AND event.status IN ('queued', 'claimed'))::int AS waiting,
         (SELECT row_to_json(last) FROM (SELECT id, status, stop_reason, summary, started_at, finished_at FROM runs
            WHERE runs.company = mate.company AND runs.teammate = mate.id ORDER BY started_at DESC LIMIT 1) last) AS last_run
       FROM teammates mate WHERE mate.company = $1 ORDER BY mate.id`,
      [company],
    );
    const visible = [];
    for (const row of mates.rows) {
      if (await check(who, "can_view", { type: "teammate", id: `${company}-${row.id}`, company })) visible.push(row);
    }
    const ids = visible.map((row) => row.id);
    const [events, runs, pending, decided, messages, spend] = await Promise.all([
      pool.query(
        `SELECT id, teammate, source, type, status, attempts, error, run_id, received_at FROM inbox_events
         WHERE company = $1 AND teammate = ANY($2) AND (status IN ('queued', 'claimed', 'dead') OR received_at > now() - interval '1 day')
         ORDER BY received_at DESC LIMIT 100`,
        [company, ids],
      ),
      pool.query(
        `SELECT id, teammate, status, stop_reason, summary, threads, steps, tokens, cost_usd, started_at, finished_at FROM runs
         WHERE company = $1 AND teammate = ANY($2) ORDER BY started_at DESC LIMIT 50`,
        [company, ids],
      ),
      approvals.list(company, "pending"),
      pool.query("SELECT id FROM approvals WHERE company = $1 AND status <> 'pending' ORDER BY decided_at DESC LIMIT 30", [company]),
      outbox.list(company),
      spendByDay(pool, company, 14),
    ]);
    const recent = await Promise.all(decided.rows.map((row) => approvals.get(company, row.id)));
    const shown = (teammate: string) => ids.includes(teammate);
    response.json({
      teammates: visible.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        paused: row.paused,
        quiet: row.quiet,
        autoPostLimit: Number(row.auto_post_limit),
        dailyBudgetUsd: Number(row.daily_budget_usd),
        waiting: row.waiting,
        lastRun: row.last_run,
      })),
      inbox: events.rows,
      runs: runs.rows.map((row) => ({ ...row, cost_usd: Number(row.cost_usd) })),
      approvals: [...pending, ...recent.filter((approval) => approval !== null)].filter((approval) => shown(approval.teammate)).map(publicApproval),
      outbox: messages.filter((message) => shown(message.teammate)).map(({ idempotencyKey: _key, ...message }) => message),
      spend,
    });
  });

  app.get("/api/runs/:id", async (request, response) => {
    const who = person(request);
    const id = z.uuid().parse(request.params.id);
    const { rows } = await pool.query("SELECT * FROM runs WHERE id = $1 AND company = $2", [id, who.company]);
    if (!rows[0]) throw new HttpError(404, "There is no such run.");
    await requireTeammate(who, rows[0].teammate, "can_view");
    const steps = await pool.query("SELECT id, kind, title, detail, at FROM run_steps WHERE run_id = $1 ORDER BY id", [id]);
    const events = await pool.query("SELECT id, source, type, status, received_at FROM inbox_events WHERE run_id = $1 ORDER BY received_at", [id]);
    response.json({ run: { ...rows[0], cost_usd: Number(rows[0].cost_usd) }, steps: steps.rows.map(publicStep), events: events.rows });
  });

  // A person decides. OpenFGA says whether this person may decide this amount; the approval
  // itself keeps the rules that hold for anyone.
  app.post("/api/approvals/:id/decide", async (request, response) => {
    const who = person(request);
    const id = z.uuid().parse(request.params.id);
    const body = Decide.parse(request.body);
    const approval = await approvals.get(who.company, id);
    if (!approval) throw new HttpError(404, "There is no such approval.");
    // An approver's limit is in the company's currency, so an amount in another currency is an admin's call.
    const foreign = approval.currency !== null && approval.currency !== COMPANIES[who.company].currency;
    if (foreign) await requireTeammate(who, approval.teammate, "can_configure", "An amount in another currency needs an admin.");
    const allowed = await check(who, "can_decide", { type: "approval", id, company: approval.company }, { amount: approval.amount ?? 0 });
    if (!allowed) throw new HttpError(403, decideRefusal(who));
    // Allow always writes a standing rule, which is a change to the teammate.
    if (body.allowAlways) await requireTeammate(who, approval.teammate, "can_configure", "Only an admin can make this a standing rule.");
    const decided = await approvals.decide({ company: who.company, id, person: who, approve: body.approve, allowAlways: body.allowAlways, note: body.note });
    response.json(publicApproval(decided));
  });

  app.post("/api/outbox/:id/release", async (request, response) => {
    const who = person(request);
    const id = z.uuid().parse(request.params.id);
    const { send } = Release.parse(request.body);
    const { rows } = await pool.query<{ teammate: string }>("SELECT teammate FROM outbox WHERE id = $1 AND company = $2", [id, who.company]);
    if (!rows[0]) throw new HttpError(404, "There is no such message.");
    await requireTeammate(who, rows[0].teammate, "can_configure");
    const { idempotencyKey: _key, ...message } = await outbox.release(who.company, id, who.email, send);
    response.json(message);
  });

  app.patch("/api/teammates/:id", async (request, response) => {
    const who = person(request);
    const teammate = TeammateId.parse(request.params.id);
    const changes = TeammateSettings.parse(request.body);
    await requireTeammate(who, teammate, "can_configure");
    const { rows } = await pool.query(
      `UPDATE teammates SET paused = coalesce($3, paused), quiet = coalesce($4, quiet),
         auto_post_limit = coalesce($5, auto_post_limit), daily_budget_usd = coalesce($6, daily_budget_usd)
       WHERE company = $1 AND id = $2 RETURNING id, paused, quiet, auto_post_limit, daily_budget_usd`,
      [who.company, teammate, changes.paused ?? null, changes.quiet ?? null, changes.autoPostLimit ?? null, changes.dailyBudgetUsd ?? null],
    );
    await pool.query("INSERT INTO audit_log (company, actor, action, subject, detail) VALUES ($1, $2, 'teammate.changed', $3, $4)", [
      who.company, who.email, teammate, JSON.stringify(changes),
    ]);
    const row = rows[0];
    response.json({ id: row.id, paused: row.paused, quiet: row.quiet, autoPostLimit: Number(row.auto_post_limit), dailyBudgetUsd: Number(row.daily_budget_usd) });
  });

  // A teammate's instructions live in its memory and are read whenever a person will decide.
  // Anyone who sees the teammate can read them; only an admin can change them.
  app.get("/api/teammates/:id/instructions", async (request, response) => {
    const who = person(request);
    const teammate = TeammateId.parse(request.params.id);
    await requireTeammate(who, teammate, "can_view");
    response.json({ text: (await deps.memory.read({ company: who.company, teammate }, INSTRUCTIONS)) ?? "" });
  });

  app.put("/api/teammates/:id/instructions", async (request, response) => {
    const who = person(request);
    const teammate = TeammateId.parse(request.params.id);
    const { text } = Instructions.parse(request.body);
    await requireTeammate(who, teammate, "can_configure");
    await deps.memory.setInstructions({ company: who.company, teammate }, text);
    await pool.query("INSERT INTO audit_log (company, actor, action, subject, detail) VALUES ($1, $2, 'instructions.changed', $3, $4)", [
      who.company, who.email, teammate, JSON.stringify({ text }),
    ]);
    response.json({ text });
  });

  // Anyone who sees a teammate may ask it something, and sees only their own thread with it.
  // How far the answer may look is decided here, from OpenFGA, never from the request.
  app.get("/api/teammates/:id/conversation", async (request, response) => {
    const who = person(request);
    const teammate = TeammateId.parse(request.params.id);
    await requireTeammate(who, teammate, "can_view");
    response.json({ lines: await conversation(pool, who.company, teammate, who.email) });
  });

  app.post("/api/teammates/:id/messages", async (request, response) => {
    const who = person(request);
    const teammate = TeammateId.parse(request.params.id);
    const { messageId, text } = Message.parse(request.body);
    await requireTeammate(who, teammate, "can_view");
    const reach = (await mayTeammate(who, teammate, "can_configure")) ? "tools" : "board";
    await say(pool, { company: who.company, teammate, person: who.email, messageId, role: "person", author: who.name, text });
    await inbox.receive({
      company: who.company, teammate, source: "person", sourceId: `${who.email}/${messageId}`, type: "person.message",
      payload: { messageId, text, from: who.name, person: who.email, reach },
    });
    response.status(202).json({ messageId });
  });

  app.get("/api/rules", async (request, response) => {
    const who = person(request);
    response.json({ rules: await rules(pool, who.company), tools: Object.fromEntries(Object.entries(TOOLS).map(([name, tool]) => [name, { description: tool.description, decision: tool.decision }])) });
  });

  // An admin sets or clears a standing rule for one tool. Clearing it puts the tool's own policy back.
  app.put("/api/teammates/:id/rules/:tool", async (request, response) => {
    const who = person(request);
    const teammate = TeammateId.parse(request.params.id);
    const tool = String(request.params.tool);
    if (!isToolName(tool)) throw new HttpError(404, "There is no such tool.");
    const { decision } = Rule.parse(request.body);
    await requireTeammate(who, teammate, "can_configure");
    // Posting a bill is decided by the invoice checks, never by a standing rule.
    if (tool === "books.post_bill") throw new HttpError(422, "Posting a bill always runs the invoice checks.");
    if (decision) await setRule(pool, { company: who.company, teammate, tool, decision, setBy: who.email });
    else await pool.query("DELETE FROM tool_rules WHERE company = $1 AND teammate = $2 AND tool = $3", [who.company, teammate, tool]);
    await pool.query("INSERT INTO audit_log (company, actor, action, subject, detail) VALUES ($1, $2, 'rule.changed', $3, $4)", [
      who.company, who.email, `${teammate}/${tool}`, JSON.stringify({ decision }),
    ]);
    response.json({ teammate, tool, decision });
  });

  app.get("/api/audit", async (request, response) => {
    const who = person(request);
    const { rows } = await pool.query("SELECT id, actor, action, subject, detail, at FROM audit_log WHERE company = $1 ORDER BY at DESC LIMIT 200", [who.company]);
    response.json({ entries: rows });
  });

  return app;
}

// What the board may show of an approval: no hashes and no internal ids of who decided.
function publicApproval(approval: Awaited<ReturnType<Approvals["get"]>> & {}) {
  const { decidedBy: _subject, ...shown } = approval;
  return shown;
}

// A run step as the board shows it. Model names stay in the trace, never on the page.
function publicStep(step: { id: string; kind: string; title: string; detail: Record<string, unknown>; at: Date }) {
  const { tier: _tier, model: _model, ...detail } = step.detail ?? {};
  return { ...step, detail };
}
