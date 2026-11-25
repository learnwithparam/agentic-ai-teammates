import type { Pool } from "pg";

// What people and a teammate say to each other in Mission Control. A person's message goes in
// here and into the teammate's inbox at once. The teammate's next run answers it with the same
// message id, so a message is answered once even when a run is tried again.

export const MAX_MESSAGE = 2000;

export type Line = { messageId: string; role: "person" | "teammate"; author: string; text: string; runId: string | null; at: string };

type LineRow = { message_id: string; role: Line["role"]; author: string; text: string; run_id: string | null; at: Date };

function toLine(row: LineRow): Line {
  return { messageId: row.message_id, role: row.role, author: row.author, text: row.text, runId: row.run_id, at: row.at.toISOString() };
}

// The last lines with one teammate, oldest first.
export async function conversation(pool: Pool, company: string, teammate: string, limit = 50): Promise<Line[]> {
  const { rows } = await pool.query<LineRow>(
    `SELECT message_id, role, author, text, run_id, at FROM (
       SELECT * FROM conversation WHERE company = $1 AND teammate = $2 ORDER BY at DESC, id DESC LIMIT $3
     ) last ORDER BY at, id`,
    [company, teammate, limit],
  );
  return rows.map(toLine);
}

// Keeps one line. A second write with the same message id and role changes nothing.
export async function say(pool: Pool, line: { company: string; teammate: string; messageId: string; role: Line["role"]; author: string; text: string; runId?: string }) {
  await pool.query(
    `INSERT INTO conversation (company, teammate, message_id, role, author, text, run_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company, teammate, message_id, role) DO NOTHING`,
    [line.company, line.teammate, line.messageId, line.role, line.author, line.text, line.runId ?? null],
  );
}

// What a teammate did lately, so it can answer "what are you doing?" from facts, not from guesses.
export async function recentWork(pool: Pool, company: string, teammate: string) {
  const runs = await pool.query(
    `SELECT started_at, status, stop_reason, summary FROM runs
     WHERE company = $1 AND teammate = $2 AND status <> 'running' ORDER BY started_at DESC LIMIT 10`,
    [company, teammate],
  );
  const waiting = await pool.query(
    `SELECT title, amount, currency, reasons, created_at FROM approvals
     WHERE company = $1 AND teammate = $2 AND status = 'pending' ORDER BY created_at`,
    [company, teammate],
  );
  return { lastRuns: runs.rows, waitingForAPerson: waiting.rows };
}
