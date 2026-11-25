import type { Pool, PoolClient } from "pg";
import { inTransaction } from "./db";

// The event inbox: the first primitive. A webhook handler only calls receive() and answers at once.
// The worker claims a batch, runs the teammate, then calls complete() or fail().
//
// The rules it keeps:
// - The same event sent twice is stored once (source and source_id are unique per inbox).
// - One teammate has at most one run at a time. Events that arrive during a run wait for the next one.
// - A run holds its events for a lease. If the worker dies, the lease runs out and the events are claimed again.
// - A failed batch is tried again later, waiting longer each time, until it is dead and a person looks at it.

export type EventType = "mail.received" | "drive.changed" | "approval.decided" | "timer.fired" | "person.message" | "person.request";

export type IncomingEvent = {
  company: string;
  teammate: string;
  source: string;
  sourceId: string;
  type: EventType;
  payload: unknown;
};

export type InboxEvent = IncomingEvent & {
  id: string;
  deliveries: number;
  attempts: number;
  receivedAt: Date;
};

export type InboxSettings = {
  // How long a run holds its events before another worker may take them.
  leaseSeconds: number;
  // The most events one run handles at once.
  batchSize: number;
  // After this many failed runs the events are dead.
  maxAttempts: number;
  // The wait before the first retry. Each later retry waits twice as long.
  retrySeconds: number;
};

export const INBOX_SETTINGS: InboxSettings = { leaseSeconds: 120, batchSize: 10, maxAttempts: 5, retrySeconds: 30 };

type EventRow = {
  id: string;
  company: string;
  teammate: string;
  source: string;
  source_id: string;
  type: EventType;
  payload: unknown;
  deliveries: number;
  attempts: number;
  received_at: Date;
};

function toEvent(row: EventRow): InboxEvent {
  const { id, company, teammate, source, type, payload, deliveries, attempts } = row;
  return { id, company, teammate, source, sourceId: row.source_id, type, payload, deliveries, attempts, receivedAt: row.received_at };
}

export class Inbox {
  constructor(
    private readonly pool: Pool,
    private readonly settings: InboxSettings = INBOX_SETTINGS,
  ) {}

  // Stores an event. first is false when the sender delivered this event before.
  async receive(event: IncomingEvent): Promise<{ id: string; first: boolean; deliveries: number }> {
    const { rows } = await this.pool.query<{ id: string; first: boolean; deliveries: number }>(
      `INSERT INTO inbox_events (company, teammate, source, source_id, type, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company, teammate, source, source_id) DO UPDATE SET deliveries = inbox_events.deliveries + 1
       RETURNING id, deliveries, (xmax = 0) AS first`,
      [event.company, event.teammate, event.source, event.sourceId, event.type, JSON.stringify(event.payload)],
    );
    return rows[0];
  }

  // The inboxes that have work a run could take now, oldest first.
  async readyInboxes(): Promise<Array<{ company: string; teammate: string }>> {
    const { rows } = await this.pool.query<{ company: string; teammate: string }>(
      `SELECT event.company, event.teammate
       FROM inbox_events event
       JOIN teammates mate ON mate.company = event.company AND mate.id = event.teammate AND NOT mate.paused
       WHERE (event.status = 'queued' AND event.available_at <= now()) OR (event.status = 'claimed' AND event.lease_until <= now())
       GROUP BY event.company, event.teammate
       ORDER BY min(event.received_at)`,
    );
    return rows;
  }

  // Claims the next batch for one teammate, or returns null when there is nothing to take.
  // Null also means another run holds this inbox, or the teammate is paused.
  async claim(company: string, teammate: string, runId: string): Promise<InboxEvent[] | null> {
    const { leaseSeconds, batchSize, maxAttempts } = this.settings;
    return inTransaction(this.pool, async (client) => {
      // One worker at a time looks at an inbox. A second one gets null at once and moves on.
      // The lock ends with the transaction.
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1 || '/' || $2, 0)) AS locked",
        [company, teammate],
      );
      if (!lock.rows[0].locked) return null;

      const mate = await client.query<{ paused: boolean }>("SELECT paused FROM teammates WHERE company = $1 AND id = $2", [company, teammate]);
      if (mate.rows.length === 0 || mate.rows[0].paused) return null;

      // A lease that ran out on the last allowed attempt means the run died every time.
      await client.query(
        `UPDATE inbox_events SET status = 'dead', finished_at = now(), lease_until = NULL,
           error = coalesce(error, 'The run stopped before it finished, on every attempt.')
         WHERE company = $1 AND teammate = $2 AND status = 'claimed' AND lease_until <= now() AND attempts >= $3`,
        [company, teammate, maxAttempts],
      );

      const running = await client.query(
        "SELECT 1 FROM inbox_events WHERE company = $1 AND teammate = $2 AND status = 'claimed' AND lease_until > now() LIMIT 1",
        [company, teammate],
      );
      if (running.rows.length > 0) return null;

      const { rows } = await client.query<EventRow>(
        `UPDATE inbox_events SET status = 'claimed', run_id = $3, attempts = attempts + 1,
           lease_until = now() + make_interval(secs => $4)
         WHERE id IN (
           SELECT id FROM inbox_events
           WHERE company = $1 AND teammate = $2
             AND ((status = 'queued' AND available_at <= now()) OR (status = 'claimed' AND lease_until <= now()))
           ORDER BY received_at, id
           LIMIT $5
           FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [company, teammate, runId, leaseSeconds, batchSize],
      );
      if (rows.length === 0) return null;
      const events = rows.map(toEvent);
      return events.sort((first, second) => first.receivedAt.getTime() - second.receivedAt.getTime() || Number(first.id) - Number(second.id));
    });
  }

  // Extends a running batch's lease. False means the lease was lost and another run may hold the events.
  async renew(runId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE inbox_events SET lease_until = now() + make_interval(secs => $2) WHERE run_id = $1 AND status = 'claimed'",
      [runId, this.settings.leaseSeconds],
    );
    return (rowCount ?? 0) > 0;
  }

  // Ends each run whose worker stopped. Such a run holds no live lease any more.
  // Its events went back to the inbox, so a later run does the work.
  // Without this, its row would say "running" forever.
  async endAbandonedRuns(): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE runs SET status = 'finished', stop_reason = 'failed', finished_at = now(),
         summary = 'The worker stopped before this run finished. Its events went back to the inbox.'
       WHERE status = 'running' AND started_at < now() - make_interval(secs => $1)
         AND NOT EXISTS (SELECT 1 FROM inbox_events event WHERE event.run_id = runs.id AND event.status = 'claimed' AND event.lease_until > now())
       RETURNING id`,
      [this.settings.leaseSeconds],
    );
    return rows.map((row) => row.id);
  }

  // Marks the run's events done. False means the run no longer held them.
  async complete(runId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE inbox_events SET status = 'done', finished_at = now(), lease_until = NULL, error = NULL WHERE run_id = $1 AND status = 'claimed'",
      [runId],
    );
    return (rowCount ?? 0) > 0;
  }

  // Puts the run's events back to try later, or marks them dead after the last attempt.
  async fail(runId: string, reason: string): Promise<"retry" | "dead" | "lost"> {
    const { maxAttempts, retrySeconds } = this.settings;
    const { rows } = await this.pool.query<{ status: "queued" | "dead" }>(
      `UPDATE inbox_events SET
         status = CASE WHEN attempts >= $3 THEN 'dead' ELSE 'queued' END,
         available_at = CASE WHEN attempts >= $3 THEN available_at
                             ELSE now() + make_interval(secs => $4 * power(2, attempts - 1)) END,
         finished_at = CASE WHEN attempts >= $3 THEN now() END,
         lease_until = NULL,
         error = $2
       WHERE run_id = $1 AND status = 'claimed'
       RETURNING status`,
      [runId, reason, maxAttempts, retrySeconds],
    );
    if (rows.length === 0) return "lost";
    return rows[0].status === "dead" ? "dead" : "retry";
  }
}

// Calls wake with "company/teammate" each time an event lands. A Postgres restart drops the connection.
// Then it connects again, waiting longer after each failure, and wakes the worker once in case a
// notice landed while it was away. The worker also polls, so a lost notice only delays work.
export const LISTEN_RETRY_MS = { first: 500, max: 30_000 };

export async function listenForEvents(
  pool: Pool,
  wake: (inbox: string) => void,
  retry = LISTEN_RETRY_MS,
): Promise<() => Promise<void>> {
  let client: PoolClient | null = null;
  let stopped = false;
  let wait = retry.first;
  let timer: NodeJS.Timeout | undefined;

  const connect = async () => {
    const next = await pool.connect();
    const lost = (error?: Error) => {
      if (client !== next) return;
      client = null;
      next.release(error ?? true);
      if (!stopped) {
        console.error(`The inbox listener lost its connection${error ? `: ${error.message}` : ""}. Connecting again.`);
        again();
      }
    };
    next.on("error", lost);
    next.on("end", () => lost());
    next.on("notification", (notice) => {
      if (notice.channel === "inbox" && notice.payload) wake(notice.payload);
    });
    await next.query("LISTEN inbox");
    client = next;
    wait = retry.first;
  };

  const again = () => {
    timer = setTimeout(() => {
      connect().then(
        () => {
          console.error("The inbox listener is connected again.");
          wake("");
        },
        (error: Error) => {
          console.error(`The inbox listener could not connect: ${error.message}. Trying again in ${Math.round(wait / 1000)}s.`);
          wait = Math.min(wait * 2, retry.max);
          if (!stopped) again();
        },
      );
    }, wait);
  };

  await connect();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    const held = client;
    client = null;
    if (!held) return;
    await held.query("UNLISTEN inbox").catch(() => {});
    held.release();
  };
}
