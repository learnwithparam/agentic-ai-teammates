import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Pool } from "pg";
import { CASES } from "../data/invoices/cases";
import { setting } from "../src/server/env";
import { Inbox } from "../src/server/inbox";
import { testDatabase } from "../src/server/test-database";
import { KEEP, MORNING, refusal, resetDatabase, resetMissionControl } from "./demo-reset";

// The demo reset empties real databases, so it is tested on the tests' own database: each test
// gets a new schema with every migration, changes it the way a working day would, and resets it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const address = () => setting("TEST_DATABASE_URL");
const count = async (pool: Pool, sql: string) => Number((await pool.query(sql)).rows[0].count);

test("the reset refuses unless the machine says it is a demo, and while the teammates read Google", () => {
  assert.match(refusal({}) ?? "", /DEMO_RESET=yes/);
  assert.match(refusal({ DEMO_RESET: "true" }) ?? "", /DEMO_RESET=yes/);
  assert.match(refusal({ DEMO_RESET: "yes", MAIL_SERVICE: "gmail" }) ?? "", /read Google/);
  assert.match(refusal({ DEMO_RESET: "yes", FILE_SERVICE: "gdrive" }) ?? "", /read Google/);
  assert.equal(refusal({ DEMO_RESET: "yes" }), null);
});

test("the demo morning names real cases", () => {
  for (const id of MORNING) assert.ok(CASES.some((invoice) => invoice.id === id), `${id} is not a case`);
});

test("Mission Control loses the day's work and keeps who signed in and where each teammate read to", async () => {
  const { pool, close } = await testDatabase();
  try {
    await pool.query("UPDATE teammates SET name = 'Our invoices', quiet = false, paused = true WHERE company = 'bramble' AND id = 'invoices'");
    await pool.query("INSERT INTO teammates (company, id, kind, name, on_duty, quiet, harness) VALUES ('bramble', 'invoice-attack', 'invoice', 'Invoice attack', false, true, true)");
    await pool.query("INSERT INTO cursors (company, teammate, source, position) VALUES ('bramble', 'invoice-attack', 'lmail', '7')");
    const runId = randomUUID();
    await pool.query("INSERT INTO runs (id, company, teammate) VALUES ($1, 'bramble', 'invoices')", [runId]);
    await pool.query(
      `INSERT INTO approvals (id, company, teammate, run_id, thread_id, tool, args, payload_hash, title, brief)
       VALUES ($1, 'bramble', 'invoices', $2, 't', 'books.post_bill', '{}', 'h', 'Post a bill', 'Brief')`,
      [randomUUID(), runId],
    );
    await new Inbox(pool).receive({ company: "bramble", teammate: "invoices", source: "lmail", sourceId: "m-1", type: "mail.received", payload: {} });
    await pool.query("INSERT INTO members (company, subject, email, name, roles) VALUES ('bramble', 'ada', 'ada@bramble.example', 'Ada', '{admin}')");
    await pool.query("INSERT INTO cursors (company, teammate, source, position) VALUES ('bramble', 'invoices', 'lmail', '41')");
    const migrations = await count(pool, "SELECT count(*) FROM schema_migrations");

    const emptied = await resetMissionControl(pool, address());
    for (const kept of KEEP.missionControl) assert.ok(!emptied.includes(kept), `${kept} was emptied`);
    assert.ok(emptied.includes("approvals") && emptied.includes("runs"));

    for (const table of ["runs", "approvals", "inbox_events"]) assert.equal(await count(pool, `SELECT count(*) FROM ${table}`), 0, `${table} still has rows`);
    const invoices = (await pool.query("SELECT name, quiet, paused FROM teammates WHERE company = 'bramble' AND id = 'invoices'")).rows[0];
    assert.deepEqual(invoices, { name: "Invoice teammate", quiet: true, paused: false }, "the teammate is not back to a new install");
    assert.equal(await count(pool, "SELECT count(*) FROM teammates WHERE harness"), 0, "an attack teammate is still on the roster");
    assert.ok((await count(pool, "SELECT count(*) FROM timers WHERE cron IS NOT NULL")) > 0, "the standing schedules did not come back");
    assert.equal(await count(pool, "SELECT count(*) FROM members"), 1);
    assert.deepEqual((await pool.query("SELECT teammate, position FROM cursors")).rows, [{ teammate: "invoices", position: "41" }]);
    assert.equal(await count(pool, "SELECT count(*) FROM schema_migrations"), migrations);
  } finally {
    await close();
  }
});

test("QuirkBooks goes back to its seed books, and its ids carry on from where they were", async () => {
  const folder = path.join(ROOT, "apps/quirkbooks/migrations");
  const { pool, close } = await testDatabase(folder);
  try {
    const seedBills = await count(pool, "SELECT count(*) FROM bills");
    const seedAudit = await count(pool, "SELECT count(*) FROM audit_log");
    await pool.query("UPDATE vendors SET iban = 'NL00CHANGED0000000000' WHERE id = (SELECT min(id) FROM vendors)");
    await pool.query("INSERT INTO audit_log (actor, action, subject, detail) VALUES ('teammate', 'bill.posted', 'b-1', '{}')");
    const lastAudit = await count(pool, "SELECT max(id) AS count FROM audit_log");
    await pool.query("INSERT INTO sessions (id, subject, tokens, expires_at) VALUES ('s-1', 'ada', '{}', now() + interval '1 day')");

    await resetDatabase(pool, address(), KEEP.quirkbooks, folder);
    assert.equal(await count(pool, "SELECT count(*) FROM bills"), seedBills);
    assert.equal(await count(pool, "SELECT count(*) FROM audit_log"), seedAudit);
    assert.equal(await count(pool, "SELECT count(*) FROM vendors WHERE iban = 'NL00CHANGED0000000000'"), 0, "a changed vendor kept its change");
    assert.equal(await count(pool, "SELECT count(*) FROM sessions"), 1, "a person was signed out");
    await pool.query("INSERT INTO audit_log (actor, action, subject, detail) VALUES ('teammate', 'bill.posted', 'b-2', '{}')");
    assert.ok((await count(pool, "SELECT max(id) AS count FROM audit_log")) > lastAudit, "an id was handed out twice");
  } finally {
    await close();
  }
});

test("LMail and LDrive keep their mailboxes, watches and folders, so each teammate's read position stays true", async () => {
  for (const [app, keep] of [["lmail", KEEP.lmail], ["ldrive", KEEP.ldrive]] as const) {
    const folder = path.join(ROOT, `apps/${app}/migrations`);
    const { pool, close } = await testDatabase(folder);
    try {
      if (app === "lmail") await pool.query("UPDATE mailboxes SET history_id = 99");
      const before = (await pool.query(app === "lmail" ? "SELECT address, history_id FROM mailboxes ORDER BY address" : "SELECT id, name FROM folders ORDER BY name")).rows;
      const emptied = await resetDatabase(pool, address(), [...keep], folder);
      for (const kept of keep) assert.ok(!emptied.includes(kept), `${app} emptied ${kept}`);
      const after = (await pool.query(app === "lmail" ? "SELECT address, history_id FROM mailboxes ORDER BY address" : "SELECT id, name FROM folders ORDER BY name")).rows;
      assert.deepEqual(after, before);
      assert.ok(emptied.length > 0, `${app} emptied nothing`);
    } finally {
      await close();
    }
  }
});

test("every table a reset keeps is a real table, so a rename never quietly empties it", async () => {
  const folders = { missionControl: undefined, lmail: "apps/lmail/migrations", ldrive: "apps/ldrive/migrations", quirkbooks: "apps/quirkbooks/migrations" };
  for (const [app, folder] of Object.entries(folders)) {
    const { pool, close } = await testDatabase(folder && path.join(ROOT, folder));
    try {
      const { rows } = await pool.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()");
      // The checkpointer makes its own table when the worker starts, so a migration never makes it.
      const expected = KEEP[app as keyof typeof KEEP].filter((table) => table !== "checkpoint_migrations");
      for (const table of expected) assert.ok(rows.some((row) => row.name === table), `${app} keeps ${table}, which no migration makes`);
    } finally {
      await close();
    }
  }
});
