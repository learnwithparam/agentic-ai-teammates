import type { Pool } from "pg";
import { parseJsonText } from "./canonical";
import { conversation, recentWork, say } from "./conversation";
import type { GatewayClient, ModelAsk, RoutedAnswer, RunRef } from "./gateway-client";
import type { ChatMessage } from "./llm";
import type { Risk, RoutingMode, Task } from "./router";
import { type ToolName, type ToolResult, toolFromModelName } from "./tools";

// One run: a teammate working one batch of inbox events. It carries the run's limits and ends
// with one stop reason. A run never retries past a limit on its own: it stops and a person
// takes over.

export type StopReason = "sent" | "nothing_to_send" | "deferred" | "handed_to_human" | "failed";

export type RunCaps = {
  // The most tool calls one open-ended loop may make.
  maxLoopSteps: number;
  // The most tokens and dollars the whole run may spend.
  maxTokens: number;
  maxCostUsd: number;
};

export const RUN_CAPS: RunCaps = { maxLoopSteps: 8, maxTokens: 150_000, maxCostUsd: 0.1 };

// A run reached a limit. The teammate stops the work in hand and hands it to a person.
export class CapReached extends Error {}

// Which outcome wins when one run worked several threads: the one a person most needs to see.
const PRIORITY: StopReason[] = ["failed", "handed_to_human", "deferred", "sent", "nothing_to_send"];

export class Run {
  tokens = 0;
  costUsd = 0;
  // Answers that did not match their schema. The eval counts them per routing mode.
  schemaFailures = 0;
  // Which tiers may answer. Only the eval sets anything but routed.
  mode: RoutingMode = "routed";
  private readonly outcomes = new Map<string, { reason: StopReason; note: string }>();
  private readonly cursors = new Map<string, string>();
  private keepCursors = true;

  constructor(
    private readonly pool: Pool,
    private readonly gateway: GatewayClient,
    readonly ref: RunRef,
    readonly caps: RunCaps = RUN_CAPS,
  ) {}

  static async start(pool: Pool, gateway: GatewayClient, ref: RunRef, caps?: RunCaps): Promise<Run> {
    await pool.query("INSERT INTO runs (id, company, teammate) VALUES ($1, $2, $3)", [ref.runId, ref.company, ref.teammate]);
    return new Run(pool, gateway, ref, caps);
  }

  // The largest invoice this teammate may post without a person. The gateway reads the same row.
  async autoPostLimit(): Promise<number> {
    const { rows } = await this.pool.query<{ limit: string }>("SELECT auto_post_limit AS limit FROM teammates WHERE company = $1 AND id = $2", [this.ref.company, this.ref.teammate]);
    if (!rows[0]) throw new Error("This teammate does not exist.");
    return Number(rows[0].limit);
  }

  private checkCaps() {
    if (this.tokens >= this.caps.maxTokens) throw new CapReached(`This run used its ${this.caps.maxTokens} tokens.`);
    if (this.costUsd >= this.caps.maxCostUsd) throw new CapReached(`This run spent its ${this.caps.maxCostUsd} dollars.`);
  }

  async model(ask: ModelAsk): Promise<RoutedAnswer> {
    this.checkCaps();
    const answer = await this.gateway.model(this.ref, { ...ask, mode: this.mode });
    if (answer.tier) {
      this.tokens += answer.answer.inputTokens + answer.answer.outputTokens;
      this.costUsd += answer.answer.costUsd;
    }
    return answer;
  }

  // A model call whose answer must match a schema. A schema failure goes back to the router,
  // which escalates it. Null means the router handed the call to a person.
  async structured<T>(ask: Omit<ModelAsk, "prior" | "schema">, schema: { name: string; schema: Record<string, unknown> }, parse: (value: unknown) => T | null): Promise<{ value: T } | { handed: string }> {
    const prior: ModelAsk["prior"] = [];
    for (;;) {
      const answer = await this.model({ ...ask, schema, prior });
      if (!answer.tier) return { handed: answer.reason };
      const value = parse(parseJsonText(answer.answer.content));
      if (value !== null) return { value };
      prior.push({ tier: answer.tier, result: "schema_failure" });
      this.schemaFailures += 1;
      await this.note("model", `The answer to ${ask.task} did not match its schema`, { tier: answer.tier });
    }
  }

  async tool(threadId: string, tool: ToolName, args: unknown, approvalId?: string): Promise<ToolResult> {
    this.checkCaps();
    return this.gateway.tool({ ...this.ref, threadId }, tool, args as never, approvalId);
  }

  // An open-ended loop over read-only tools. It ends when the model answers without a tool
  // call, or after maxLoopSteps tool calls, when a person takes over.
  async toolLoop(input: { threadId: string; task: Task; risk: Risk; messages: ChatMessage[]; tools: ToolName[]; maxTokens: number }): Promise<{ answer: string } | { handed: string }> {
    const messages = [...input.messages];
    let steps = 0;
    const prior: ModelAsk["prior"] = [];
    for (;;) {
      const answer = await this.model({ task: input.task, risk: input.risk, prior, messages, tools: input.tools, maxTokens: input.maxTokens });
      if (!answer.tier) return { handed: answer.reason };
      const { content, toolCalls } = answer.answer;
      if (toolCalls.length === 0) {
        if (content?.trim()) return { answer: content.trim() };
        prior.push({ tier: answer.tier, result: "error" });
        continue;
      }
      messages.push({
        role: "assistant",
        content,
        tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })),
      });
      for (const call of toolCalls) {
        steps += 1;
        if (steps > this.caps.maxLoopSteps) {
          await this.note("note", "The loop reached its step limit", { steps: this.caps.maxLoopSteps });
          return { handed: `The teammate looked ${this.caps.maxLoopSteps} times without an answer.` };
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: await this.loopTool(input.threadId, input.tools, call.name, call.arguments) });
      }
    }
  }

  // A tool the model asked for, run through the gateway. Its result, or why it failed, goes
  // back to the model as text.
  private async loopTool(threadId: string, offered: ToolName[], name: string, rawArguments: string): Promise<string> {
    const tool = toolFromModelName(name);
    if (!tool || !offered.includes(tool)) return JSON.stringify({ error: `There is no tool called ${name}.` });
    const args = parseJsonText(rawArguments);
    if (args === null) return JSON.stringify({ error: "The arguments were not valid JSON." });
    try {
      const result = await this.tool(threadId, tool, args);
      return JSON.stringify(result.status === "done" ? result.result : result).slice(0, 12_000);
    } catch (error) {
      if (error instanceof CapReached) throw error;
      return JSON.stringify({ error: error instanceof Error ? error.message : "The tool failed." });
    }
  }

  // What a teammate answers a person from: their thread so far and its own recent work.
  async talkContext(person: string) {
    const { company, teammate } = this.ref;
    return { conversation: await conversation(this.pool, company, teammate, person, 20), ...(await recentWork(this.pool, company, teammate)) };
  }

  // The teammate's answer to one message. Answering the same message again changes nothing.
  async reply(person: string, messageId: string, text: string) {
    const { company, teammate, runId } = this.ref;
    await say(this.pool, { company, teammate, person, messageId, role: "teammate", author: teammate, text, runId });
  }

  async note(kind: "check" | "note" | "model", title: string, detail: Record<string, unknown> = {}) {
    await this.pool.query("INSERT INTO run_steps (run_id, kind, title, detail) VALUES ($1, $2, $3, $4)", [
      this.ref.runId, kind === "model" ? "note" : kind, title, JSON.stringify(detail),
    ]);
  }

  // Each thread the run worked ends in one outcome; the run's stop reason is the one that matters most.
  outcome(threadId: string, reason: StopReason, note: string) {
    this.outcomes.set(threadId, { reason, note });
  }

  // Where the last finished run read a source up to, or null before the first one.
  async cursor(source: string): Promise<string | null> {
    return readCursor(this.pool, this.ref.company, this.ref.teammate, source);
  }

  // Where this run read a source up to. Saved only when the run finishes without failing.
  advanceCursor(source: string, position: string) {
    this.cursors.set(source, position);
  }

  // Work was left undone, so the next run must read the sources from where this one started.
  holdCursors() {
    this.keepCursors = false;
  }

  stopReason(): StopReason {
    const reasons = [...this.outcomes.values()].map((outcome) => outcome.reason);
    return PRIORITY.find((reason) => reasons.includes(reason)) ?? "nothing_to_send";
  }

  async finish(failure?: string): Promise<StopReason> {
    const stop = failure ? "failed" : this.stopReason();
    const notes = [...this.outcomes.values()].map((outcome) => outcome.note);
    const summary = failure ?? (notes.length ? notes.join(" ") : "Nothing new to work on.");
    const threads = [...this.outcomes.keys()];
    const { company, teammate, runId } = this.ref;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!failure && this.keepCursors) {
        for (const [source, position] of this.cursors) {
          await client.query(
            `INSERT INTO cursors (company, teammate, source, position) VALUES ($1, $2, $3, $4)
             ON CONFLICT (company, teammate, source) DO UPDATE SET position = $4, updated_at = now()`,
            [company, teammate, source, position],
          );
        }
      }
      const steps = await client.query<{ count: string }>("SELECT count(*) AS count FROM run_steps WHERE run_id = $1 AND kind = 'tool'", [runId]);
      await client.query(
        `UPDATE runs SET status = 'finished', stop_reason = $2, summary = $3, threads = $4, steps = $5, finished_at = now() WHERE id = $1`,
        [runId, stop, summary.slice(0, 4000), threads, Number(steps.rows[0].count)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return stop;
  }
}

export async function readCursor(pool: Pool, company: string, teammate: string, source: string): Promise<string | null> {
  const { rows } = await pool.query<{ position: string }>("SELECT position FROM cursors WHERE company = $1 AND teammate = $2 AND source = $3", [company, teammate, source]);
  return rows[0]?.position ?? null;
}
