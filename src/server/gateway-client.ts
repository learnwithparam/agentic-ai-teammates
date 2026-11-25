import { z } from "zod";
import type { ChatMessage } from "./llm";
import type { Tier } from "./models";
import type { Outcome, Risk, RoutingMode, Task } from "./router";
import type { ToolArgs, ToolName, ToolResult } from "./tools";

// How the worker and the dispatcher reach the gateway. They hold a gateway token and nothing
// else: no model key, no world app key.

export type RunRef = { runId: string; company: string; teammate: string };

export type ModelAnswer = { content: string | null; toolCalls: { id: string; name: string; arguments: string }[]; inputTokens: number; outputTokens: number; costUsd: number };
export type RoutedAnswer = { tier: null; reason: string } | { tier: Tier; reason: string; answer: ModelAnswer };

export type ModelAsk = {
  task: Task;
  risk: Risk;
  prior: Outcome[];
  mode?: RoutingMode;
  messages: ChatMessage[];
  schema?: { name: string; schema: Record<string, unknown> };
  tools?: ToolName[];
  maxTokens: number;
};

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async post<T>(route: string, body: unknown, timeoutMs = 180_000): Promise<T> {
    const response = await fetch(new URL(route, this.baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = (await response.json().catch(() => ({}))) as { error?: string; retryable?: boolean };
    if (!response.ok) {
      const retryable = answer.retryable ?? (response.status >= 500 || response.status === 429);
      throw new GatewayError(response.status, answer.error ?? `The gateway answered ${response.status}.`, retryable);
    }
    return answer as T;
  }

  model(run: RunRef, ask: ModelAsk): Promise<RoutedAnswer> {
    return this.post("/model", { ...run, ...ask });
  }

  tool<Name extends ToolName>(run: RunRef & { threadId: string }, tool: Name, args: ToolArgs<Name>, approvalId?: string): Promise<ToolResult> {
    return this.post(`/tools/${tool}`, { ...run, args, ...(approvalId ? { approvalId } : {}) });
  }

  // A reading tool whose answer the caller checks with a schema.
  async read<Name extends ToolName, Result>(run: RunRef & { threadId: string }, tool: Name, args: ToolArgs<Name>, schema: z.ZodType<Result>): Promise<Result> {
    const result = await this.tool(run, tool, args);
    if (result.status !== "done") throw new Error(`${tool} did not run: ${result.status}.`);
    return schema.parse(result.result);
  }

  dispatch(target: string, body: { company: string; idempotencyKey: string; payload: unknown }): Promise<unknown> {
    return this.post(`/dispatch/${target}`, body, 60_000);
  }
}
