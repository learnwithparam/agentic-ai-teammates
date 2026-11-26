import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { Pool, PoolClient } from "pg";
import { inTransaction } from "./db";

// Timers: the second primitive. A follow-up fires once; a schedule repeats on a cron line. When
// one is due, the scheduler writes an event to the teammate's inbox. A timer never starts a run.

export type TimerSpec = { cron: string; timezone: string } | { at: Date };
// A pool, or one client inside a transaction, so a timer can be set in the same transaction.
type Queryable = Pool | PoolClient;

// When a cron line next fires after a moment. A line that never fires again is refused.
export function nextFire(cron: string, timezone: string, after: Date): Date {
  const next = new Cron(cron, { timezone, paused: true }).nextRun(after);
  if (!next) throw new Error(`The schedule "${cron}" never fires again.`);
  return next;
}

const DAYS: Record<string, string> = {
  "*": "Every day", "1-5": "Weekdays", "0": "Sundays", "1": "Mondays", "2": "Tuesdays", "3": "Wednesdays", "4": "Thursdays", "5": "Fridays", "6": "Saturdays",
};

// A cron line in the words a person reads, such as "Weekdays at 09:00". A line it cannot say
// plainly is shown as it is, so nothing is ever described wrong.
export function cronWords(cron: string): string {
  const [minute, hour, dayOfMonth, month, weekdays, ...rest] = cron.trim().split(/\s+/);
  const plain = rest.length === 0 && /^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") && dayOfMonth === "*" && month === "*";
  const days = weekdays === undefined ? undefined : DAYS[weekdays];
  if (!plain || !days) return cron;
  return `${days} at ${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
}

function columns(spec: TimerSpec) {
  if ("at" in spec) return { cron: null, timezone: null, fireAt: spec.at };
  return { cron: spec.cron, timezone: spec.timezone, fireAt: nextFire(spec.cron, spec.timezone, new Date()) };
}

// Sets a timer by name, or moves it when it is already set. A name is unique per teammate.
export async function setTimer(database: Queryable, company: string, teammate: string, name: string, spec: TimerSpec, payload: Record<string, unknown> = {}) {
  const { cron, timezone, fireAt } = columns(spec);
  await database.query(
    `INSERT INTO timers (id, company, teammate, name, cron, timezone, fire_at, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company, teammate, name) DO UPDATE SET cron = $5, timezone = $6, fire_at = $7, payload = $8, status = 'waiting'`,
    [randomUUID(), company, teammate, name, cron, timezone, fireAt, JSON.stringify(payload)],
  );
}

// Sets a schedule only when the teammate has none by that name, so a time a person changed stays.
export async function ensureSchedule(database: Queryable, company: string, teammate: string, name: string, spec: { cron: string; timezone: string }) {
  await database.query(
    `INSERT INTO timers (id, company, teammate, name, cron, timezone, fire_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company, teammate, name) DO NOTHING`,
    [randomUUID(), company, teammate, name, spec.cron, spec.timezone, nextFire(spec.cron, spec.timezone, new Date())],
  );
}

export async function cancelTimer(database: Queryable, company: string, teammate: string, name: string) {
  await database.query("UPDATE timers SET status = 'cancelled' WHERE company = $1 AND teammate = $2 AND name = $3 AND status = 'waiting'", [
    company, teammate, name,
  ]);
}

// Writes every due timer to its teammate's inbox, once. A schedule moves to its next time; a
// follow-up is spent. Two schedulers never fire one timer twice: the rows are locked, and the
// inbox refuses a second event for the same firing.
export async function fireDue(pool: Pool, now = new Date()): Promise<{ name: string; teammate: string }[]> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM timers WHERE status = 'waiting' AND fire_at <= $1 ORDER BY fire_at LIMIT 100 FOR UPDATE SKIP LOCKED",
      [now],
    );
    for (const timer of rows) {
      const firing = (timer.fire_at as Date).toISOString();
      await client.query(
        `INSERT INTO inbox_events (company, teammate, source, source_id, type, payload)
         VALUES ($1, $2, 'timer', $3, 'timer.fired', $4) ON CONFLICT DO NOTHING`,
        [timer.company, timer.teammate, `${timer.name}@${firing}`, JSON.stringify({ ...timer.payload, name: timer.name, firedFor: firing })],
      );
      if (timer.cron) {
        // A scheduler that was down for days fires a schedule once, not once per missed time.
        await client.query("UPDATE timers SET fire_at = $2, last_fired_at = $3 WHERE id = $1", [timer.id, nextFire(timer.cron, timer.timezone, now), now]);
      } else {
        await client.query("UPDATE timers SET status = 'fired', last_fired_at = $2 WHERE id = $1", [timer.id, now]);
      }
    }
    return rows.map((timer) => ({ name: String(timer.name), teammate: String(timer.teammate) }));
  });
}
