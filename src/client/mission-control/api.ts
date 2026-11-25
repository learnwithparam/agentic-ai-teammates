import { z } from "zod";

// What Mission Control's server answers, read with the same shapes the server test checks
// (src/server/web-app.test.ts parses a real answer with these). A change on one side fails there.

const StopReason = z.enum(["sent", "nothing_to_send", "deferred", "handed_to_human", "failed"]);
export type StopReason = z.infer<typeof StopReason>;

const RunSummary = z.object({
  id: z.string(),
  status: z.enum(["running", "finished"]),
  stop_reason: StopReason.nullable(),
  summary: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

export const Teammate = z.object({
  id: z.string(),
  kind: z.enum(["invoice", "news"]),
  name: z.string(),
  paused: z.boolean(),
  quiet: z.boolean(),
  autoPostLimit: z.number(),
  dailyBudgetUsd: z.number(),
  waiting: z.number(),
  lastRun: RunSummary.nullable(),
});
export type Teammate = z.infer<typeof Teammate>;

export const InboxEvent = z.object({
  id: z.string(),
  teammate: z.string(),
  source: z.string(),
  type: z.string(),
  status: z.enum(["queued", "claimed", "done", "dead"]),
  attempts: z.number(),
  error: z.string().nullable(),
  run_id: z.string().nullable(),
  received_at: z.string(),
});
export type InboxEvent = z.infer<typeof InboxEvent>;

export const Run = RunSummary.extend({
  teammate: z.string(),
  threads: z.array(z.string()).nullable(),
  steps: z.number(),
  tokens: z.number(),
  cost_usd: z.number(),
});
export type Run = z.infer<typeof Run>;

const InvoiceLine = z.object({ description: z.string(), amount: z.number() }).partial();

// The invoice the teammate read, as far as it got. A run that stopped early leaves gaps.
const Invoice = z
  .object({
    vendorName: z.string(),
    invoiceNumber: z.string(),
    total: z.number(),
    currency: z.string(),
    tax: z.number(),
    iban: z.string().nullable(),
    poNumber: z.string().nullable(),
    dueDate: z.string().nullable(),
    lines: z.array(InvoiceLine),
  })
  .partial();

// Where the invoice came from. A file from LDrive has no sender.
const Source = z
  .object({ kind: z.enum(["mail", "drive"]), sender: z.string().nullable(), subject: z.string() })
  .partial();

export const Approval = z.object({
  id: z.string(),
  teammate: z.string(),
  runId: z.string(),
  tool: z.string(),
  args: z.object({ source: Source.optional(), invoice: Invoice.optional() }).loose(),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  title: z.string(),
  brief: z.string(),
  reasons: z.array(z.string()),
  status: z.enum(["pending", "approved", "denied"]),
  canAllowAlways: z.boolean(),
  decidedByName: z.string().nullable(),
  decisionNote: z.string().nullable(),
  allowAlways: z.boolean(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const OutboxMessage = z.object({
  id: z.string(),
  teammate: z.string(),
  runId: z.string().nullable(),
  target: z.enum(["lmail.send", "github.publish"]),
  title: z.string(),
  payload: z.unknown(),
  status: z.enum(["draft", "queued", "sending", "sent", "discarded", "dead"]),
  attempts: z.number(),
  error: z.string().nullable(),
  releasedBy: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});
export type OutboxMessage = z.infer<typeof OutboxMessage>;

const SpendDay = z.object({ day: z.string(), teammate: z.string(), costUsd: z.number() });
export type SpendDay = z.infer<typeof SpendDay>;

export const Board = z.object({
  teammates: z.array(Teammate),
  inbox: z.array(InboxEvent),
  runs: z.array(Run),
  approvals: z.array(Approval),
  outbox: z.array(OutboxMessage),
  spend: z.array(SpendDay),
});
export type Board = z.infer<typeof Board>;

export const SignedIn = z.object({
  name: z.string(),
  email: z.string(),
  company: z.string(),
  roles: z.array(z.string()),
  approvalLimit: z.number().nullable(),
});
export type SignedIn = z.infer<typeof SignedIn>;

const Step = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  detail: z.record(z.string(), z.unknown()),
  at: z.string(),
});
export type Step = z.infer<typeof Step>;

const WokeBy = z.object({
  id: z.string(),
  source: z.string(),
  type: z.string(),
  status: z.string(),
  received_at: z.string(),
});

export const RunDetail = z.object({
  run: Run,
  steps: z.array(Step),
  events: z.array(WokeBy),
});
export type RunDetail = z.infer<typeof RunDetail>;

const Line = z.object({
  messageId: z.string(),
  role: z.enum(["person", "teammate"]),
  author: z.string(),
  text: z.string(),
  runId: z.string().nullable(),
  at: z.string(),
});
export type Line = z.infer<typeof Line>;
export const Conversation = z.object({ lines: z.array(Line) });

export const Decision = z.enum(["allow", "classify", "approve"]);
export type Decision = z.infer<typeof Decision>;

export const Rules = z.object({
  rules: z.array(
    z.object({ teammate: z.string(), tool: z.string(), decision: Decision, setBy: z.string(), setAt: z.string() }),
  ),
  tools: z.record(z.string(), z.object({ description: z.string(), decision: Decision })),
});
export type Rules = z.infer<typeof Rules>;

const AuditRow = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  subject: z.string(),
  detail: z.unknown(),
  at: z.string(),
});

export const Audit = z.object({
  entries: z.array(AuditRow),
});
export type AuditEntry = z.infer<typeof Audit>["entries"][number];

export const Instructions = z.object({ text: z.string() });

// The server's own words for a refusal, such as "This amount is above what you can approve."
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function signIn() {
  const back = window.location.pathname + window.location.search;
  window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(back)}`);
}

async function send(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) {
    signIn();
    throw new ApiError("Signing you in again.", 401);
  }
  const body = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
  if (!response.ok) throw new ApiError(body?.error ?? `The server answered ${response.status}.`, response.status);
  return body;
}

// An answer in a shape the page does not expect is logged for the developer. The person sees a
// plain sentence, never the parser's report.
export async function get<T>(path: string, shape: z.ZodType<T>): Promise<T> {
  const answer = shape.safeParse(await send(path));
  if (answer.success) return answer.data;
  console.error(`${path} answered in an unexpected shape`, answer.error.issues);
  throw new ApiError("Mission Control got an answer it cannot read. Reload the page, and if it stays, tell your admin.", 200);
}

export function post(path: string, body: unknown, method = "POST") {
  return send(path, { method, body: JSON.stringify(body) });
}

// Ends this session, then Keycloak's, so the next visit asks for a password again.
export async function signOut() {
  const { redirect } = z.object({ redirect: z.string() }).parse(await send("/api/auth/logout", { method: "POST" }));
  window.location.assign(redirect);
}
