import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { HttpError } from "../../apps/shared/server";
import { inTransaction } from "./db";
import { cancelTimer, setTimer } from "./timers";
import { payloadHash } from "./canonical";
import { setRule } from "./policy";
import { type CardLine, isToolName, type ToolName } from "./tools";

// An approval is a deferred tool call. The gateway writes one and the run ends. A person decides
// on the board, and the decision lands in the teammate's inbox as an event, which resumes the run.
// The call then runs once, and only with the exact arguments the person saw.

export type NewApproval = {
  company: string;
  teammate: string;
  runId: string;
  threadId: string;
  tool: ToolName;
  args: unknown;
  amount: number | null;
  currency: string | null;
  title: string;
  brief: string;
  reasons: string[];
  // A failed invoice check is a fact about one invoice, so it never offers "allow always".
  canAllowAlways: boolean;
  // The items the person approves, when the tool lists them. Most cards have none.
  lines?: CardLine[];
};

export type Approval = {
  id: string;
  company: string;
  teammate: string;
  runId: string;
  threadId: string;
  tool: string;
  args: unknown;
  amount: number | null;
  currency: string | null;
  title: string;
  brief: string;
  reasons: string[];
  status: "pending" | "approved" | "denied";
  canAllowAlways: boolean;
  lines: CardLine[];
  decidedBy: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  allowAlways: boolean;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
};

function toApproval(row: Record<string, unknown>): Approval {
  const date = (value: unknown) => (value instanceof Date ? value.toISOString() : null);
  return {
    id: String(row.id),
    company: String(row.company),
    teammate: String(row.teammate),
    runId: String(row.run_id),
    threadId: String(row.thread_id),
    tool: String(row.tool),
    args: row.args,
    amount: row.amount === null ? null : Number(row.amount),
    currency: (row.currency as string | null) ?? null,
    title: String(row.title),
    brief: String(row.brief),
    reasons: row.reasons as string[],
    status: row.status as Approval["status"],
    canAllowAlways: Boolean(row.can_allow_always),
    lines: (row.lines as CardLine[] | undefined) ?? [],
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedByName: (row.decided_by_name as string | null) ?? null,
    decisionNote: (row.decision_note as string | null) ?? null,
    allowAlways: Boolean(row.allow_always),
    createdAt: date(row.created_at)!,
    decidedAt: date(row.decided_at),
    executedAt: date(row.executed_at),
  };
}

export const REMIND_AFTER_HOURS = 24;

// The timer that reminds people about one approval.
export function reminderName(approvalId: string): string {
  return `remind:${approvalId}`;
}

export class Approvals {
  constructor(private readonly pool: Pool) {}

  // Asking twice for the same call in the same thread gives back the first approval. So a
  // run that is tried again never puts two cards on the board.
  async request(approval: NewApproval): Promise<Approval> {
    const hash = payloadHash(approval.args);
    return inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${approval.threadId}:${hash}`]);
      const existing = await client.query(
        "SELECT * FROM approvals WHERE company = $1 AND thread_id = $2 AND payload_hash = $3 AND status = 'pending'",
        [approval.company, approval.threadId, hash],
      );
      if (existing.rows[0]) return toApproval(existing.rows[0]);
      const { rows } = await client.query(
        `INSERT INTO approvals (id, company, teammate, run_id, thread_id, tool, args, payload_hash, amount, currency, title, brief, reasons, can_allow_always, lines)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [
          randomUUID(), approval.company, approval.teammate, approval.runId, approval.threadId, approval.tool,
          JSON.stringify(approval.args), hash, approval.amount, approval.currency, approval.title, approval.brief,
          JSON.stringify(approval.reasons), approval.canAllowAlways, JSON.stringify(approval.lines ?? []),
        ],
      );
      // If nobody decides within a day, the teammate reminds the people who can.
      const remindAt = new Date(Date.now() + REMIND_AFTER_HOURS * 3_600_000);
      await setTimer(client, approval.company, approval.teammate, reminderName(rows[0].id), { at: remindAt }, { approvalId: rows[0].id });
      return toApproval(rows[0]);
    });
  }

  async get(company: string, id: string): Promise<Approval | null> {
    const { rows } = await this.pool.query("SELECT * FROM approvals WHERE company = $1 AND id = $2", [company, id]);
    return rows[0] ? toApproval(rows[0]) : null;
  }

  async list(company: string, status?: Approval["status"]): Promise<Approval[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM approvals WHERE company = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT 200`,
      [company, status ?? null],
    );
    return rows.map(toApproval);
  }

  // Records a person's decision and wakes the teammate. Who may decide is checked before this,
  // with OpenFGA; this keeps the rules that hold whoever decides.
  async decide(input: {
    company: string;
    id: string;
    person: { subject: string; name: string; email: string };
    approve: boolean;
    allowAlways: boolean;
    note: string | null;
  }): Promise<Approval> {
    const approval = await inTransaction(this.pool, async (client) => {
      const { rows } = await client.query("SELECT * FROM approvals WHERE company = $1 AND id = $2 FOR UPDATE", [input.company, input.id]);
      if (!rows[0]) throw new HttpError(404, "There is no such approval.");
      const current = toApproval(rows[0]);
      if (current.status !== "pending") throw new HttpError(409, `This approval was already ${current.status}.`);
      if (input.allowAlways && (!input.approve || !current.canAllowAlways)) {
        throw new HttpError(422, "This approval cannot become a standing rule.");
      }
      const status = input.approve ? "approved" : "denied";
      const updated = await client.query(
        `UPDATE approvals SET status = $2, decided_by = $3, decided_by_name = $4, decision_note = $5, allow_always = $6, decided_at = now()
         WHERE id = $1 RETURNING *`,
        [input.id, status, input.person.subject, input.person.name, input.note, input.allowAlways],
      );
      await client.query("INSERT INTO audit_log (company, actor, action, subject, detail) VALUES ($1, $2, $3, $4, $5)", [
        input.company, input.person.email, `approval.${status}`, input.id,
        JSON.stringify({ tool: current.tool, title: current.title, amount: current.amount, allowAlways: input.allowAlways, note: input.note }),
      ]);
      await cancelTimer(client, current.company, current.teammate, reminderName(input.id));
      // The decision is an event in the teammate's inbox. The worker picks it up and resumes the run.
      await client.query(
        `INSERT INTO inbox_events (company, teammate, source, source_id, type, payload)
         VALUES ($1, $2, 'approval', $3, 'approval.decided', $4) ON CONFLICT DO NOTHING`,
        [current.company, current.teammate, input.id, JSON.stringify({ approvalId: input.id, threadId: current.threadId, status })],
      );
      return toApproval(updated.rows[0]);
    });
    if (input.allowAlways && isToolName(approval.tool)) {
      await setRule(this.pool, { company: approval.company, teammate: approval.teammate, tool: approval.tool, decision: "allow", setBy: input.person.email });
    }
    return approval;
  }

  // Marks an approved call as running, once. It must be this teammate's approval for this tool,
  // and the arguments must hash to what the person approved.
  async claimForExecution(company: string, teammate: string, id: string, tool: ToolName, args: unknown): Promise<{ ok: true; approval: Approval } | { ok: false; reason: string }> {
    const { rows } = await this.pool.query(
      `UPDATE approvals SET executed_at = now()
       WHERE company = $1 AND teammate = $2 AND id = $3 AND tool = $4 AND payload_hash = $5 AND status = 'approved' AND executed_at IS NULL
       RETURNING *`,
      [company, teammate, id, tool, payloadHash(args)],
    );
    if (rows[0]) return { ok: true, approval: toApproval(rows[0]) };
    const approval = await this.get(company, id);
    if (!approval || approval.teammate !== teammate || approval.tool !== tool) return { ok: false, reason: "There is no such approval for this call." };
    if (approval.status === "denied") return { ok: false, reason: `${approval.decidedByName ?? "A person"} denied this.` };
    if (approval.status === "pending") return { ok: false, reason: "This call is still waiting for a person." };
    if (approval.executedAt) return { ok: false, reason: "This approved call already ran." };
    return { ok: false, reason: "These are not the arguments the person approved." };
  }

  // A call that failed after its claim may be tried again under the same approval.
  async releaseExecution(id: string) {
    await this.pool.query("UPDATE approvals SET executed_at = NULL WHERE id = $1", [id]);
  }
}
