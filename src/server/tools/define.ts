import type { z } from "zod";
import type { Approvals } from "../approvals";
import type { GatewayDeps } from "../gateway-app";
import type { Outbox } from "../outbox";

// The one shape every tool has. A tool says what it needs and what it does.
// The gateway's callTool runs the same steps for each tool, in the same order. No tool can skip one.
//
//   allowlist: the teammate's definition must list the tool.
//   args: the arguments must parse.
//   guard: the tool's own hard checks. They can refuse, or ask a person.
//   policy: a standing rule a person set, or the tool's default. It is allow, classify or approve.
//   approval: an approved call runs once, with the exact arguments the person saw.
//   run: the tool does its work, and the step is recorded.
//
// The policy for each tool, unless a person set a standing rule for it:
//   allow     runs at once. Reading is always allowed.
//   classify  the quick model judges whether this one call is safe and in scope; if not, a person decides.
//   approve   a person decides every time.

export type Decision = "allow" | "classify" | "approve";

// What a tool call returned to the teammate.
export type ToolResult =
  | { status: "done"; result: unknown }
  | { status: "needs_approval"; approvalId: string; reasons: string[] }
  | { status: "denied"; reason: string };

export type ToolScope = { runId: string; company: string; teammate: string; threadId: string };

export type ToolContext = {
  scope: ToolScope;
  // The teammate's settings, read when the call came in.
  teammate: { kind: string; quiet: boolean; autoPostLimit: number };
  deps: GatewayDeps;
  approvals: Approvals;
  outbox: Outbox;
};

// How a call was let through. A quiet teammate's message waits as a draft; one a person
// approved is queued at once, in their name.
export type Grant = { send: "draft" | "queued"; decidedBy: string | null; because: string };

// What a guard found. deny refuses the call. reasons ask a person, even when the policy allows it.
// state carries what the guard read to the run, so it is not read twice. because, when a call
// runs without a person, says why in the words the record keeps, such as "Asked by Ravi Menon".
// judgeWith is what the quick check reads in place of the model's arguments: facts the gateway
// read itself, such as the person's own words.
export type GuardResult<State> = { deny?: string; reasons?: string[]; state?: State; because?: string; judgeWith?: unknown };

export type ApprovalCard = { title: string; brief: string; amount?: number; currency?: string; canAllowAlways: boolean };

export type ToolDefinition<Args extends z.ZodType = z.ZodType, State = unknown> = {
  description: string;
  args: Args;
  decision: Decision;
  // A read-only tool may be offered to a model in an open-ended loop.
  readOnly: boolean;
  // A small write that stays inside the company, such as a follow-up or a progress line. A model
  // may call it in chat, and it still runs through every step of callTool. Every other write is
  // never offered to a model.
  modelMayCall?: boolean;
  // What the quick model reads to judge one call. A tool without them is never judged: a person decides.
  judgeRules?: string;
  // The reason a person sees when a standing rule asks them to approve every call.
  ruleReason?: string;
  // Why no standing rule may change this tool's policy. A tool that moves money, or whose own
  // checks decide, keeps its decision whatever a rule in tool_rules says.
  fixedPolicy?: string;
  guard?: (ctx: ToolContext, args: z.infer<Args>) => Promise<GuardResult<State>>;
  // The approval card a person sees when this call waits for them. Every writing tool has one.
  card?: (args: z.infer<Args>, reasons: string[]) => ApprovalCard;
  run: (ctx: ToolContext, args: z.infer<Args>, grant: Grant, state: State | undefined) => Promise<ToolResult>;
};

export function defineTool<Args extends z.ZodType, State = unknown>(tool: ToolDefinition<Args, State>): ToolDefinition<Args, State> {
  if (!tool.readOnly && !tool.card) throw new Error(`A writing tool needs an approval card: ${tool.description}`);
  return tool;
}

// A reading tool: always allowed, never judged, and it only returns what it read.
export function readTool<Args extends z.ZodType>(
  description: string,
  args: Args,
  read: (ctx: ToolContext, args: z.infer<Args>) => Promise<unknown>,
): ToolDefinition<Args> {
  return defineTool({ description, args, decision: "allow", readOnly: true, run: async (ctx, parsed) => ({ status: "done", result: await read(ctx, parsed) }) });
}
