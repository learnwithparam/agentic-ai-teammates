import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { HttpError } from "../../apps/shared/server";

// The outbox: the fifth primitive. A teammate never sends anything itself. Its message becomes a
// row here, and the dispatcher sends queued rows at a steady pace, retrying on failure.
// Each row has an idempotency key, so the same message is stored once and sent once.
//
// A quiet teammate's messages wait as drafts until a person releases them. Every teammate
// starts quiet.

export const TARGETS = ["lmail.send", "news.publish"] as const;
export type Target = (typeof TARGETS)[number];
export type OutboxStatus = "draft" | "queued" | "sending" | "sent" | "discarded" | "dead";

export type NewMessage = {
  company: string;
  teammate: string;
  runId: string | null;
  target: Target;
  title: string;
  idempotencyKey: string;
  payload: unknown;
  status: "draft" | "queued";
  releasedBy?: string;
};

export type OutboxMessage = {
  id: string;
  company: string;
  teammate: string;
  runId: string | null;
  target: Target;
  title: string;
  idempotencyKey: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  error: string | null;
  result: unknown;
  releasedBy: string | null;
  createdAt: string;
  sentAt: string | null;
};

// The dispatcher's pacing and retry rules.
export const OUTBOX_SETTINGS = {
  // At most one message per target in this many milliseconds.
  spacingMs: 2000,
  leaseSeconds: 60,
  maxAttempts: 6,
  // The wait before the first retry; each later one waits twice as long.
  retrySeconds: 20,
};

function toMessage(row: Record<string, unknown>): OutboxMessage {
  const date = (value: unknown) => (value instanceof Date ? value.toISOString() : null);
  return {
    id: String(row.id),
    company: String(row.company),
    teammate: String(row.teammate),
    runId: (row.run_id as string | null) ?? null,
    target: row.target as Target,
    title: String(row.title),
    idempotencyKey: String(row.idempotency_key),
    payload: row.payload,
    status: row.status as OutboxStatus,
    attempts: Number(row.attempts),
    error: (row.error as string | null) ?? null,
    result: row.result ?? null,
    releasedBy: (row.released_by as string | null) ?? null,
    createdAt: date(row.created_at)!,
    sentAt: date(row.sent_at),
  };
}

export class Outbox {
  constructor(private readonly pool: Pool) {}

  // Stores a message once per idempotency key and returns the stored row.
  async add(message: NewMessage): Promise<{ message: OutboxMessage; first: boolean }> {
    const { rows } = await this.pool.query(
      `INSERT INTO outbox (id, company, teammate, run_id, target, title, idempotency_key, payload, status, released_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [
        randomUUID(), message.company, message.teammate, message.runId, message.target, message.title,
        message.idempotencyKey, JSON.stringify(message.payload), message.status, message.releasedBy ?? null,
      ],
    );
    if (rows[0]) return { message: toMessage(rows[0]), first: true };
    const existing = await this.pool.query("SELECT * FROM outbox WHERE idempotency_key = $1", [message.idempotencyKey]);
    return { message: toMessage(existing.rows[0]), first: false };
  }

  async list(company: string, statuses?: OutboxStatus[]): Promise<OutboxMessage[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM outbox WHERE company = $1 AND ($2::text[] IS NULL OR status = ANY($2))
       ORDER BY created_at DESC LIMIT 200`,
      [company, statuses ?? null],
    );
    return rows.map(toMessage);
  }

  // A person sends a draft on its way, or throws it away.
  async release(company: string, id: string, actor: string, send: boolean): Promise<OutboxMessage> {
    const { rows } = await this.pool.query(
      `UPDATE outbox SET status = $3, released_by = $4, available_at = now()
       WHERE company = $1 AND id = $2 AND status = 'draft' RETURNING *`,
      [company, id, send ? "queued" : "discarded", actor],
    );
    if (!rows[0]) throw new HttpError(409, "Only a draft can be sent or discarded.");
    await this.pool.query("INSERT INTO audit_log (company, actor, action, subject, detail) VALUES ($1, $2, $3, $4, $5)", [
      company, actor, send ? "outbox.released" : "outbox.discarded", id, JSON.stringify({ title: rows[0].title, target: rows[0].target }),
    ]);
    return toMessage(rows[0]);
  }

  // Takes the next message that is due on a target whose pacing allows a send now. The pacing
  // row is locked too, so two dispatchers never send to one target inside the spacing.
  async claim(): Promise<OutboxMessage | null> {
    const { spacingMs, leaseSeconds } = OUTBOX_SETTINGS;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT message.* FROM outbox message
         LEFT JOIN outbox_pacing pacing ON pacing.target = message.target
         WHERE ((message.status = 'queued' AND message.available_at <= now())
                OR (message.status = 'sending' AND message.lease_until <= now()))
           AND (pacing.last_sent_at IS NULL OR pacing.last_sent_at <= now() - make_interval(secs => $1 / 1000.0))
         ORDER BY message.available_at, message.created_at
         LIMIT 1
         FOR UPDATE OF message SKIP LOCKED`,
        [spacingMs],
      );
      if (!rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const paced = await client.query(
        `INSERT INTO outbox_pacing (target, last_sent_at) VALUES ($1, now())
         ON CONFLICT (target) DO UPDATE SET last_sent_at = now()
         WHERE outbox_pacing.last_sent_at <= now() - make_interval(secs => $2 / 1000.0)
         RETURNING target`,
        [rows[0].target, spacingMs],
      );
      if (paced.rowCount === 0) {
        await client.query("COMMIT");
        return null;
      }
      const claimed = await client.query(
        `UPDATE outbox SET status = 'sending', attempts = attempts + 1, lease_until = now() + make_interval(secs => $2)
         WHERE id = $1 RETURNING *`,
        [rows[0].id, leaseSeconds],
      );
      await client.query("COMMIT");
      return toMessage(claimed.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async sent(id: string, result: unknown) {
    await this.pool.query("UPDATE outbox SET status = 'sent', sent_at = now(), lease_until = NULL, error = NULL, result = $2 WHERE id = $1 AND status = 'sending'", [
      id, JSON.stringify(result),
    ]);
  }

  // A failure that a retry can fix waits longer each time. One that cannot, or the last
  // attempt, makes the message dead, and the board shows it with the reason.
  async failed(id: string, reason: string, retryable: boolean): Promise<"retry" | "dead"> {
    const { maxAttempts, retrySeconds } = OUTBOX_SETTINGS;
    const { rows } = await this.pool.query<{ status: "queued" | "dead" }>(
      `UPDATE outbox SET
         status = CASE WHEN NOT $3 OR attempts >= $4 THEN 'dead' ELSE 'queued' END,
         available_at = now() + make_interval(secs => $5 * power(2, attempts - 1)),
         lease_until = NULL, error = $2
       WHERE id = $1 AND status = 'sending' RETURNING status`,
      [id, reason, retryable, maxAttempts, retrySeconds],
    );
    return rows[0]?.status === "dead" ? "dead" : "retry";
  }
}
