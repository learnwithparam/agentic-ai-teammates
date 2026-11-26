import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { Pool } from "pg";
import { Approvals, REMIND_AFTER_HOURS, reminderName } from "./approvals";
import { ensureStandingSchedules } from "./scheduler-loop";
import { companyDay } from "./teammates/timed";
import { testDatabase } from "./test-database";
import { cancelTimer, fireDue, nextFire, setTimer } from "./timers";
import { TEAMMATES } from "./teammates/registry";

// Timers against a real Postgres. Each firing must reach the inbox exactly once, and a timer
// must never start a run: it only writes an event.

let pool: Pool;
let close: () => Promise<void>;
const HOUR = 3_600_000;

before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());
beforeEach(async () => {
  await pool.query("DELETE FROM inbox_events");
  await pool.query("DELETE FROM timers");
});

async function timerEvents() {
  const { rows } = await pool.query("SELECT source_id, payload FROM inbox_events WHERE source = 'timer' ORDER BY id");
  return rows as { source_id: string; payload: Record<string, unknown> }[];
}

async function timer(name: string) {
  const { rows } = await pool.query("SELECT status, fire_at, last_fired_at FROM timers WHERE name = $1", [name]);
  return rows[0];
}

test("a follow-up fires once, carries its payload, and is spent", async () => {
  await setTimer(pool, "bramble", "invoices", "follow-up", { at: new Date(Date.now() - 1000) }, { approvalId: "a-1" });
  assert.equal((await fireDue(pool)).length, 1);
  assert.equal((await fireDue(pool)).length, 0);
  const events = await timerEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.approvalId, "a-1");
  assert.equal(events[0].payload.name, "follow-up");
  assert.equal((await timer("follow-up")).status, "fired");
  const { rows } = await pool.query("SELECT count(*)::int AS runs FROM runs");
  assert.equal(rows[0].runs, 0);
});

test("a timer that is not due yet, or was cancelled, does not fire", async () => {
  await setTimer(pool, "bramble", "invoices", "later", { at: new Date(Date.now() + HOUR) });
  await setTimer(pool, "bramble", "invoices", "called-off", { at: new Date(Date.now() - 1000) });
  await cancelTimer(pool, "bramble", "invoices", "called-off");
  assert.deepEqual(await fireDue(pool), []);
  assert.equal((await timer("called-off")).status, "cancelled");
});

test("a schedule moves to its next time, and a scheduler that was down fires it once, not once per miss", async () => {
  await setTimer(pool, "bramble", "invoices", "digest", { cron: "0 18 * * *", timezone: "Europe/Amsterdam" });
  // Pretend the scheduler was down for three days.
  await pool.query("UPDATE timers SET fire_at = now() - interval '3 days' WHERE name = 'digest'");
  const now = new Date();
  assert.equal((await fireDue(pool, now)).length, 1);
  assert.equal((await fireDue(pool, now)).length, 0);
  const after = await timer("digest");
  assert.equal(after.status, "waiting");
  assert.equal(after.fire_at.getTime(), nextFire("0 18 * * *", "Europe/Amsterdam", now).getTime());
  assert.equal((await timerEvents()).length, 1);
});

test("two schedulers at once fire a timer once", async () => {
  await setTimer(pool, "bramble", "invoices", "race", { at: new Date(Date.now() - 1000) });
  const [first, second] = await Promise.all([fireDue(pool), fireDue(pool)]);
  assert.equal(first.length + second.length, 1);
  assert.equal((await timerEvents()).length, 1);
});

test("a schedule runs on the company's clock, across a clock change", () => {
  // Amsterdam moves its clocks back on 25 Oct 2026. Six in the evening is 16:00 UTC before, 17:00 after.
  assert.equal(nextFire("0 18 * * *", "Europe/Amsterdam", new Date("2026-10-24T12:00:00Z")).toISOString(), "2026-10-24T16:00:00.000Z");
  assert.equal(nextFire("0 18 * * *", "Europe/Amsterdam", new Date("2026-10-26T12:00:00Z")).toISOString(), "2026-10-26T17:00:00.000Z");
  // Half past midnight in Amsterdam is still the day before in UTC.
  assert.equal(companyDay(new Date("2026-11-24T23:30:00Z"), "Europe/Amsterdam"), "2026-11-25");
});

test("starting the scheduler again keeps a schedule a person moved, and skips a teammate off duty", async () => {
  await pool.query("INSERT INTO teammates (company, id, kind, name, on_duty) VALUES ('bramble', 'scorer', 'invoice', 'Scorer', false)");
  await ensureStandingSchedules(pool);
  const { rows } = await pool.query("SELECT teammate, cron, timezone FROM timers WHERE name = 'digest' ORDER BY teammate");
  // Every registered teammate with a digest gets one, and the off-duty scorer does not.
  const withDigest = TEAMMATES.filter((teammate) => teammate.capabilities.digest).map((teammate) => teammate.id).sort();
  assert.ok(withDigest.includes("invoices"));
  assert.deepEqual(rows, withDigest.map((teammate) => ({ teammate, cron: "0 18 * * 1-5", timezone: "Europe/Amsterdam" })));
  await pool.query("UPDATE timers SET cron = '0 9 * * 1-5' WHERE teammate = 'invoices' AND name = 'digest'");
  await ensureStandingSchedules(pool);
  assert.equal((await pool.query("SELECT cron FROM timers WHERE teammate = 'invoices' AND name = 'digest'")).rows[0].cron, "0 9 * * 1-5");
});

test("an approval sets a reminder for a day later, and a decision cancels it", async () => {
  const runId = randomUUID();
  await pool.query("INSERT INTO runs (id, company, teammate) VALUES ($1, 'bramble', 'invoices')", [runId]);
  const approvals = new Approvals(pool);
  const asked = Date.now();
  const approval = await approvals.request({
    company: "bramble", teammate: "invoices", runId, threadId: "invoice:drive:file-9", tool: "books.post_bill", args: { n: 1 },
    amount: 900, currency: "EUR", title: "Kestrel Freelance KF-9", brief: "New vendor.", reasons: ["unknown_vendor"], canAllowAlways: false,
  });
  const set = await timer(reminderName(approval.id));
  assert.equal(set.status, "waiting");
  assert.ok(Math.abs(set.fire_at.getTime() - (asked + REMIND_AFTER_HOURS * HOUR)) < 60_000);

  await approvals.decide({
    company: "bramble", id: approval.id, person: { subject: "s-1", name: "Ravi Menon", email: "ravi@bramble.example" },
    approve: true, allowAlways: false, note: null,
  });
  assert.equal((await timer(reminderName(approval.id))).status, "cancelled");
});
