import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import express, { type Express } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { apiKeys } from "../../apps/shared/api-keys";
import { createApp, HttpError } from "../../apps/shared/server";
import { ServiceError } from "./adapters/http";
import type { Accounting, FileSource, MailSource } from "./adapters/types";
import { Approvals } from "./approvals";
import { type Memory } from "./memory";
import { parseJsonText } from "./canonical";
import { GitHubError } from "./github";
import type { NewsPublisher } from "./news-shelf";
import { type readArticle } from "./news/article";
import { type NewsDesk } from "./news/desk";
import type { collectStories } from "./news/sources";
import type { CallModel, ChatMessage, ToolSpec } from "./llm";
import type { Tier } from "./models";
import { Outbox } from "./outbox";
import { COMPANIES } from "./people";
import { decisionFor } from "./policy";
import { FAST_TASKS, type Outcome, route, ROUTING_MODES, STRONG_TASKS, type Task } from "./router";
import { budgetLeft, recordSpend } from "./spend";
import { allowedTools } from "./teammates/registry";
import { type Card, isToolName, modelToolSpec, type ToolContext, toolDefinition, type ToolName, type ToolResult } from "./tools";

// The gateway: the permissions primitive. It holds every credential (the OpenRouter key and the
// world apps' keys), so a teammate never sees one. The worker asks it for model calls and tool
// calls; the dispatcher asks it to send what the outbox holds. Every tool call goes through callTool:
// the teammate's allowlist, the tool's own guard, then a policy of allow, classify (the quick
// model judges it) or approve (a person decides). The tools themselves live in tools/.

export type GatewayDeps = {
  pool: Pool;
  callModel: CallModel;
  mail: (company: string) => MailSource;
  files: FileSource;
  books: Accounting;
  // Mission Control's own news page, or a GitHub Pages site when NEWS_TARGET is github.
  publisher: NewsPublisher;
  memory: Memory;
  // The news sources and the article reader. Both reach the public internet, so only the gateway runs them.
  news: { collect: (desk: NewsDesk) => ReturnType<typeof collectStories>; read: typeof readArticle };
  tokens: { worker: string; dispatcher: string };
};

export { PUBLISHED_LOOKBACK_DAYS } from "./tools/news";

const RunScope = z.object({
  runId: z.uuid(),
  company: z.string().min(1),
  teammate: z.string().min(1),
});
type RunScope = z.infer<typeof RunScope>;

const ModelBody = RunScope.extend({
  task: z.enum([...FAST_TASKS, ...STRONG_TASKS]),
  risk: z.enum(["low", "high"]),
  prior: z.array(z.object({ tier: z.enum(["fast", "strong"]), result: z.enum(["schema_failure", "low_confidence", "error"]) })).max(4),
  mode: z.enum(ROUTING_MODES).default("routed"),
  messages: z.array(z.looseObject({ role: z.enum(["system", "user", "assistant", "tool"]) })).min(1).max(60),
  schema: z
    .object({
      name: z.string().regex(/^[\w-]{1,64}$/),
      schema: z.record(z.string(), z.unknown()),
    })
    .optional(),
  tools: z.array(z.string()).max(12).optional(),
  maxTokens: z.number().int().min(64).max(8000),
});

const ToolBody = RunScope.extend({
  threadId: z.string().min(1).max(300),
  args: z.unknown(),
  approvalId: z.uuid().optional(),
});

const DispatchBody = z.object({
  company: z.string().min(1),
  idempotencyKey: z.string().min(1).max(300),
  payload: z.unknown(),
});
const MailPayload = z.object({
  to: z.email(),
  subject: z.string().min(1),
  text: z.string().min(1),
  inReplyTo: z.string().nullable(),
});
const NewsCard = z.looseObject({ url: z.string(), headline: z.string() });
const NewsPayload = z.object({ day: z.string(), cards: z.array(NewsCard) });

const TIER_LABEL: Record<Tier, string> = { fast: "Quick check", strong: "Deeper look" };

const Verdict = z.object({ safe: z.boolean(), reason: z.string().min(1).max(300) });
const VERDICT_SCHEMA = {
  name: "verdict",
  schema: {
    type: "object",
    properties: { safe: { type: "boolean" }, reason: { type: "string" } },
    required: ["safe", "reason"],
    additionalProperties: false,
  },
};

export function createGatewayApp(deps: GatewayDeps): Express {
  const { pool, callModel, books, files, memory } = deps;
  const approvals = new Approvals(pool);
  const outbox = new Outbox(pool);
  const app = createApp("gateway", { postgres: () => pool.query("SELECT 1"), storage: () => memory.ready() });
  app.use(express.json({ limit: "2mb" }));
  // A call that comes with a run's trace continues it, so one run is one trace in Langfuse.
  app.use((request, _response, next) => context.with(propagation.extract(ROOT_CONTEXT, request.headers), next));
  const requireScope = apiKeys([
    { name: "worker", scopes: ["model", "tools"], key: deps.tokens.worker },
    { name: "dispatcher", scopes: ["dispatch"], key: deps.tokens.dispatcher },
  ]);

  // A call belongs to a run that is still going, for a teammate that is not paused.
  async function requireRun(scope: RunScope) {
    const { rows } = await pool.query<{ status: string; kind: string; paused: boolean; quiet: boolean; auto_post_limit: string }>(
      `SELECT run.status, mate.kind, mate.paused, mate.quiet, mate.auto_post_limit FROM runs run
       JOIN teammates mate ON mate.company = run.company AND mate.id = run.teammate
       WHERE run.id = $1 AND run.company = $2 AND run.teammate = $3`,
      [scope.runId, scope.company, scope.teammate],
    );
    if (!rows[0]) throw new HttpError(404, "There is no such run for this teammate.");
    if (rows[0].status !== "running") throw new HttpError(409, "This run has finished.");
    if (rows[0].paused) throw new HttpError(423, "This teammate is paused.");
    return { kind: rows[0].kind, quiet: rows[0].quiet, autoPostLimit: Number(rows[0].auto_post_limit) };
  }

  async function step(runId: string, kind: "route" | "model" | "tool", title: string, detail: Record<string, unknown>) {
    await pool.query("INSERT INTO run_steps (run_id, kind, title, detail) VALUES ($1, $2, $3, $4)", [runId, kind, title, JSON.stringify(detail)]);
  }

  // Routes one call, asks the model, and records what it cost. A null tier means a person takes it.
  async function routedCall(
    scope: RunScope,
    call: { task: Task; risk: "low" | "high"; prior: Outcome[]; mode: (typeof ROUTING_MODES)[number]; messages: ChatMessage[]; schema?: { name: string; schema: Record<string, unknown> }; tools?: ToolSpec[]; maxTokens: number },
  ) {
    const left = await budgetLeft(pool, scope.company, scope.teammate);
    const decision = left <= 0 ? { tier: null, reason: "Today's budget for this teammate is spent." } : route(call.task, call.risk, left, call.prior, call.mode);
    await step(scope.runId, "route", decision.tier ? TIER_LABEL[decision.tier] : "Sent to a person", { task: call.task, tier: decision.tier, reason: decision.reason });
    if (!decision.tier) return { tier: null, reason: decision.reason } as const;
    const answer = await callModel({
      tier: decision.tier,
      messages: call.messages,
      schema: call.schema,
      tools: call.tools,
      maxTokens: call.maxTokens,
      trace: { runId: scope.runId, teammate: scope.teammate, company: scope.company, task: call.task },
    });
    const { inputTokens, outputTokens, costUsd } = answer;
    await recordSpend(pool, { ...scope, tier: decision.tier, task: call.task, inputTokens, outputTokens, costUsd });
    await step(scope.runId, "model", `${TIER_LABEL[decision.tier]}: ${call.task}`, { tier: decision.tier, inputTokens, outputTokens, costUsd });
    return { tier: decision.tier, reason: decision.reason, answer } as const;
  }

  // The quick model judges one outgoing call. Null means no model could judge it, so a person does.
  async function judge(scope: RunScope, tool: ToolName, rules: string | undefined, args: unknown): Promise<z.infer<typeof Verdict> | null> {
    if (!rules) return null;
    const prior: Outcome[] = [];
    for (;;) {
      const result = await routedCall(scope, {
        task: "classify",
        risk: "high",
        prior,
        mode: "routed",
        messages: [
          { role: "system", content: rules },
          { role: "user", content: `Tool: ${tool}\nArguments:\n${JSON.stringify(args, null, 2)}` },
        ],
        schema: VERDICT_SCHEMA,
        maxTokens: 400,
      });
      if (!result.tier) return null;
      const parsed = Verdict.safeParse(parseJsonText(result.answer.content));
      if (parsed.success) return parsed.data;
      prior.push({ tier: result.tier, result: "schema_failure" });
    }
  }

  async function deferToPerson(
    scope: RunScope & { threadId: string },
    tool: ToolName,
    args: unknown,
    card: { title: string; brief: string; reasons: string[]; amount?: number; currency?: string; canAllowAlways: boolean },
  ): Promise<ToolResult> {
    const approval = await approvals.request({
      ...scope,
      tool,
      args,
      amount: card.amount ?? null,
      currency: card.currency ?? null,
      title: card.title,
      brief: card.brief,
      reasons: card.reasons,
      canAllowAlways: card.canAllowAlways,
    });
    return { status: "needs_approval", approvalId: approval.id, reasons: card.reasons };
  }

  // Runs an approved call once. If the call fails, the approval can run it on the next try.
  async function runApproved(
    scope: RunScope,
    tool: ToolName,
    args: unknown,
    approvalId: string,
    execute: (approval: { decidedByName: string | null }) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const claim = await approvals.claimForExecution(scope.company, scope.teammate, approvalId, tool, args);
    if (!claim.ok) return { status: "denied", reason: claim.reason };
    try {
      return await execute(claim.approval);
    } catch (error) {
      await approvals.releaseExecution(approvalId);
      throw error;
    }
  }

  // ---------- callTool: the same steps for every tool ----------

  // The order never changes, so a new tool cannot skip a step. See tools/define.ts.
  async function callTool(ctx: ToolContext, name: ToolName, raw: unknown, approvalId: string | undefined): Promise<ToolResult> {
    const tool = toolDefinition(name);
    const { scope } = ctx;
    const args = tool.args.parse(raw);
    const checked = tool.guard ? await tool.guard(ctx, args) : {};
    if (checked.deny) return { status: "denied", reason: checked.deny };
    const send = ctx.teammate.quiet ? "draft" : "queued";
    if (approvalId) {
      return runApproved(scope, name, args, approvalId, (approval) => {
        const approver = approval.decidedByName ?? "a person";
        return tool.run(ctx, args, { send: "queued", decidedBy: approval.decidedByName, because: `Approved by ${approver}.` }, checked.state);
      });
    }
    let reasons = checked.reasons ?? [];
    if (reasons.length === 0) {
      const rule = await decisionFor(pool, scope.company, scope.teammate, name);
      if (rule === "allow") return tool.run(ctx, args, { send, decidedBy: null, because: "Every check passed." }, checked.state);
      const verdict = rule === "classify" ? await judge(scope, name, tool.judgeRules, args) : null;
      if (verdict?.safe) return tool.run(ctx, args, { send, decidedBy: null, because: "The quick check found it safe." }, checked.state);
      if (verdict) reasons = [verdict.reason];
      else if (rule === "approve") reasons = [tool.ruleReason ?? "A standing rule asks a person to approve every call of this tool."];
      else reasons = ["No quick check could judge this call."];
    }
    if (!tool.card) return { status: "denied", reason: `${name} has no approval card, so it cannot wait for a person.` };
    return deferToPerson(scope, name, args, { ...tool.card(args, reasons), reasons });
  }

  // ---------- Routes ----------

  app.post("/model", requireScope("model"), async (request, response) => {
    const body = ModelBody.parse(request.body);
    const teammate = await requireRun(body);
    const tools = (body.tools ?? []).map((name) => {
      if (!isToolName(name) || !toolDefinition(name).readOnly) throw new HttpError(422, `${name} cannot be offered to a model.`);
      if (!allowedTools(teammate.kind).has(name)) throw new HttpError(403, `${name} is not one of the ${teammate.kind} teammate's tools.`);
      return modelToolSpec(name);
    });
    const result = await routedCall(body, { ...body, messages: body.messages as ChatMessage[], tools: tools.length ? tools : undefined });
    response.json(result);
  });

  app.post("/tools/:tool", requireScope("tools"), async (request, response) => {
    const name = String(request.params.tool);
    if (!isToolName(name)) throw new HttpError(404, `There is no tool called ${name}.`);
    const body = ToolBody.parse(request.body);
    const teammate = await requireRun(body);
    // The allowlist comes first: a teammate calls only the tools its definition lists.
    if (!allowedTools(teammate.kind).has(name)) {
      await step(body.runId, "tool", `${name}: not this teammate's tool`, { tool: name, status: "refused", kind: teammate.kind });
      throw new HttpError(403, `${name} is not one of the ${teammate.kind} teammate's tools.`);
    }
    let result: ToolResult;
    try {
      result = await callTool({ scope: body, teammate, deps, approvals, outbox }, name, body.args, body.approvalId);
    } catch (error) {
      if (error instanceof ServiceError && error.status < 500) throw new HttpError(422, error.detail);
      throw error;
    }
    const outcome = result.status === "done" ? "done" : result.status === "needs_approval" ? "waiting for a person" : "denied";
    await step(body.runId, "tool", `${name}: ${outcome}`, { tool: name, status: result.status, ...(result.status === "denied" ? { reason: result.reason } : {}) });
    response.json(result);
  });

  app.post("/dispatch/:target", requireScope("dispatch"), async (request, response) => {
    const body = DispatchBody.parse(request.body);
    const company = COMPANIES[body.company];
    if (!company) throw new HttpError(404, "There is no such company.");
    try {
      if (request.params.target === "lmail.send") {
        const mail = MailPayload.parse(body.payload);
        response.json(await deps.mail(body.company).send(mail, body.idempotencyKey));
        return;
      }
      if (request.params.target === "news.publish") {
        const edition = NewsPayload.parse(body.payload) as { day: string; cards: Card[] };
        const published = await deps.publisher.publish(body.company, { day: edition.day, publishedAt: new Date().toISOString(), cards: edition.cards });
        for (const card of edition.cards) {
          await pool.query(
            "INSERT INTO news_published (company, url, day, headline) VALUES ($1, $2, $3, $4) ON CONFLICT (company, url) DO NOTHING",
            [body.company, card.url, edition.day, card.headline],
          );
        }
        response.json(published);
        return;
      }
      throw new HttpError(404, "There is no such target.");
    } catch (error) {
      // The dispatcher retries what a retry can fix: a timeout, a 5xx or a 429.
      if (error instanceof ServiceError || error instanceof GitHubError) {
        const retryable = error.status >= 500 || error.status === 429;
        response.status(502).json({ error: error.message, retryable });
        return;
      }
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "TypeError")) {
        response.status(502).json({ error: error.message, retryable: true });
        return;
      }
      throw error;
    }
  });

  return app;
}
