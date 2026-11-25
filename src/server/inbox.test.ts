import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { INBOX_SETTINGS, Inbox, type IncomingEvent, listenForEvents } from "./inbox";
import { testDatabase } from "./test-database";

let pool: Pool;
let close: () => Promise<void>;

before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());

// Each test gets its own teammate, so tests never see each other's events.
async function newTeammate(): Promise<string> {
  const teammate = `invoices-${randomUUID().slice(0, 8)}`;
  await pool.query("INSERT INTO teammates (company, id, kind, name) VALUES ('bramble', $1, 'invoice', 'Invoices')", [teammate]);
  return teammate;
}

function mail(teammate: string, sourceId: string): IncomingEvent {
  return { company: "bramble", teammate, source: "lmail", sourceId, type: "mail.received", payload: { historyId: sourceId } };
}

// Moves a run's lease into the past, as if its worker died and the time ran out.
async function expireLease(runId: string) {
  await pool.query("UPDATE inbox_events SET lease_until = now() - interval '1 second' WHERE run_id = $1", [runId]);
}

async function statusOf(teammate: string): Promise<string[]> {
  const { rows } = await pool.query<{ status: string }>("SELECT status FROM inbox_events WHERE teammate = $1 ORDER BY id", [teammate]);
  return rows.map((row) => row.status);
}

test("the same event delivered twice is stored once", async () => {
  const inbox = new Inbox(pool);
  const teammate = await newTeammate();
  const first = await inbox.receive(mail(teammate, "history-1"));
  const second = await inbox.receive(mail(teammate, "history-1"));
  assert.equal(first.first, true);
  assert.equal(second.first, false);
  assert.equal(second.id, first.id);
  assert.equal(second.deliveries, 2);
  assert.deepEqual(await statusOf(teammate), ["queued"]);
});

test("two workers claiming the same inbox at once: exactly one gets the batch", async () => {
  const teammate = await newTeammate();
  await new Inbox(pool).receive(mail(teammate, "history-1"));
  const workers = Array.from({ length: 6 }, () => new Inbox(pool));
  const claims = await Promise.all(workers.map((worker) => worker.claim("bramble", teammate, randomUUID())));
  assert.equal(claims.filter((claim) => claim !== null).length, 1);
});

test("a run takes the oldest events, up to the batch size, in order", async () => {
  const inbox = new Inbox(pool, { ...INBOX_SETTINGS, batchSize: 2 });
  const teammate = await newTeammate();
  for (const sourceId of ["history-1", "history-2", "history-3"]) await inbox.receive(mail(teammate, sourceId));
  const runId = randomUUID();
  const batch = await inbox.claim("bramble", teammate, runId);
  assert.deepEqual(batch?.map((event) => event.sourceId), ["history-1", "history-2"]);
  assert.equal(batch?.[0].attempts, 1);
  await inbox.complete(runId);
  const rest = await inbox.claim("bramble", teammate, randomUUID());
  assert.deepEqual(rest?.map((event) => event.sourceId), ["history-3"]);
});

test("an event that arrives during a run waits for the next run", async () => {
  const inbox = new Inbox(pool);
  const teammate = await newTeammate();
  await inbox.receive(mail(teammate, "history-1"));
  const runId = randomUUID();
  assert.ok(await inbox.claim("bramble", teammate, runId));
  await inbox.receive(mail(teammate, "history-2"));
  assert.equal(await inbox.claim("bramble", teammate, randomUUID()), null);
  assert.equal(await inbox.complete(runId), true);
  const next = await inbox.claim("bramble", teammate, randomUUID());
  assert.deepEqual(next?.map((event) => event.sourceId), ["history-2"]);
});

test("when a worker dies, its events are claimed again after the lease, and the dead run cannot finish them", async () => {
  const inbox = new Inbox(pool);
  const teammate = await newTeammate();
  await inbox.receive(mail(teammate, "history-1"));
  const deadRun = randomUUID();
  await inbox.claim("bramble", teammate, deadRun);
  assert.equal(await inbox.claim("bramble", teammate, randomUUID()), null);
  await expireLease(deadRun);
  const retryRun = randomUUID();
  const retry = await inbox.claim("bramble", teammate, retryRun);
  assert.equal(retry?.[0].attempts, 2);
  assert.equal(await inbox.renew(deadRun), false);
  assert.equal(await inbox.complete(deadRun), false);
  assert.equal(await inbox.complete(retryRun), true);
  assert.deepEqual(await statusOf(teammate), ["done"]);
});

test("a failed run is tried again after a wait, then dead after the last attempt", async () => {
  const waiting = new Inbox(pool, { ...INBOX_SETTINGS, retrySeconds: 60 });
  const teammate = await newTeammate();
  await waiting.receive(mail(teammate, "history-1"));
  const firstRun = randomUUID();
  await waiting.claim("bramble", teammate, firstRun);
  assert.equal(await waiting.fail(firstRun, "QuirkBooks answered 503"), "retry");
  assert.equal(await waiting.claim("bramble", teammate, randomUUID()), null, "the retry waits");

  const inbox = new Inbox(pool, { ...INBOX_SETTINGS, retrySeconds: 0, maxAttempts: 3 });
  await pool.query("UPDATE inbox_events SET available_at = now() WHERE teammate = $1", [teammate]);
  const outcomes: string[] = [];
  for (let attempt = 2; attempt <= 3; attempt++) {
    const runId = randomUUID();
    const batch = await inbox.claim("bramble", teammate, runId);
    assert.equal(batch?.[0].attempts, attempt);
    outcomes.push(await inbox.fail(runId, "QuirkBooks answered 503"));
  }
  assert.deepEqual(outcomes, ["retry", "dead"]);
  assert.equal(await inbox.claim("bramble", teammate, randomUUID()), null);
  const { rows } = await pool.query("SELECT status, error FROM inbox_events WHERE teammate = $1", [teammate]);
  assert.deepEqual(rows, [{ status: "dead", error: "QuirkBooks answered 503" }]);
});

test("a run that dies on its last attempt leaves its events dead, not claimed forever", async () => {
  const inbox = new Inbox(pool, { ...INBOX_SETTINGS, maxAttempts: 1 });
  const teammate = await newTeammate();
  await inbox.receive(mail(teammate, "history-1"));
  const runId = randomUUID();
  await inbox.claim("bramble", teammate, runId);
  await expireLease(runId);
  assert.equal(await inbox.claim("bramble", teammate, randomUUID()), null);
  assert.deepEqual(await statusOf(teammate), ["dead"]);
});

test("a paused teammate is not woken", async () => {
  const inbox = new Inbox(pool);
  const teammate = await newTeammate();
  await inbox.receive(mail(teammate, "history-1"));
  await pool.query("UPDATE teammates SET paused = true WHERE id = $1", [teammate]);
  assert.equal(await inbox.claim("bramble", teammate, randomUUID()), null);
  const ready = await inbox.readyInboxes();
  assert.equal(ready.some((entry) => entry.teammate === teammate), false);
  await pool.query("UPDATE teammates SET paused = false WHERE id = $1", [teammate]);
  assert.equal((await inbox.readyInboxes()).some((entry) => entry.teammate === teammate), true);
});

test("a new event wakes a listening worker", async () => {
  const inbox = new Inbox(pool);
  const teammate = await newTeammate();
  let stop = async () => {};
  const woken = new Promise<string>((resolve) => {
    listenForEvents(pool, (name) => {
      if (name.endsWith(teammate)) resolve(name);
    }).then((unlisten) => {
      stop = unlisten;
      return inbox.receive(mail(teammate, "history-1"));
    });
  });
  assert.equal(await woken, `bramble/${teammate}`);
  await stop();
});

test("the listener connects again after Postgres drops its connection", async () => {
  const inbox = new Inbox(pool);
  const teammate = await newTeammate();
  const woken: string[] = [];
  const stop = await listenForEvents(pool, (name) => woken.push(name), { first: 50, max: 200 });
  try {
    // What a Postgres restart does to the listener: its backend is ended from the server side.
    const { rowCount } = await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND query = 'LISTEN inbox' AND pid <> pg_backend_pid()`,
    );
    assert.ok(rowCount && rowCount > 0, "No listening connection was found to end.");
    const deadline = Date.now() + 5000;
    while (!woken.includes("") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(woken.includes(""), "The listener did not connect again and wake the worker.");
    await inbox.receive(mail(teammate, "after-reconnect"));
    while (!woken.includes(`bramble/${teammate}`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(woken.includes(`bramble/${teammate}`), "A notice after the drop did not wake the worker.");
  } finally {
    await stop();
  }
});

test("an event that succeeds on a retry no longer shows the earlier error", async () => {
  const inbox = new Inbox(pool, { ...INBOX_SETTINGS, retrySeconds: 0 });
  const teammate = await newTeammate();
  await inbox.receive(mail(teammate, "history-retry"));
  const firstRun = randomUUID();
  await inbox.claim("bramble", teammate, firstRun);
  await inbox.fail(firstRun, "LMail did not answer");
  const secondRun = randomUUID();
  await inbox.claim("bramble", teammate, secondRun);
  assert.equal(await inbox.complete(secondRun), true);
  const { rows } = await pool.query("SELECT status, error FROM inbox_events WHERE teammate = $1", [teammate]);
  assert.deepEqual(rows, [{ status: "done", error: null }]);
});

test("a run whose worker stopped is ended, and a long run that still holds its lease is left alone", async () => {
  const inbox = new Inbox(pool);
  const teammate = await newTeammate();
  await inbox.receive(mail(teammate, "history-1"));
  const stopped = randomUUID();
  const working = randomUUID();
  await inbox.claim("bramble", teammate, stopped);
  await expireLease(stopped);
  await inbox.claim("bramble", teammate, working);
  for (const runId of [stopped, working]) {
    await pool.query("INSERT INTO runs (id, company, teammate, started_at) VALUES ($1, 'bramble', $2, now() - interval '1 hour')", [runId, teammate]);
  }
  const ended = await inbox.endAbandonedRuns();
  assert.ok(ended.includes(stopped));
  assert.ok(!ended.includes(working));
  const { rows } = await pool.query("SELECT id, status, stop_reason FROM runs WHERE id = ANY($1)", [[stopped, working]]);
  const byId = Object.fromEntries(rows.map((row) => [row.id, `${row.status}/${row.stop_reason}`]));
  assert.equal(byId[stopped], "finished/failed");
  assert.equal(byId[working], "running/null");
});
