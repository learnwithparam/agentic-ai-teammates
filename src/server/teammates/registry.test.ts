import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import type { GatewayClient } from "../gateway-client";
import { Inbox } from "../inbox";
import { testDatabase } from "../test-database";
import { TOOLS } from "../tools";
import { workInbox } from "../worker-loop";
import { defineTeammate } from "./define";
import { ensureTeammates } from "./ensure";
import { TEAMMATES } from "./registry";

let pool: Pool;
let close: () => Promise<void>;

before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());

test("every tool is used by some teammate, and every teammate has its own folder and tests", () => {
  const used = new Set(TEAMMATES.flatMap((teammate) => teammate.tools));
  assert.deepEqual(Object.keys(TOOLS).filter((tool) => !used.has(tool as never)), []);
  assert.equal(new Set(TEAMMATES.map((teammate) => teammate.kind)).size, TEAMMATES.length);
  assert.equal(new Set(TEAMMATES.map((teammate) => teammate.id)).size, TEAMMATES.length);
  for (const teammate of TEAMMATES) {
    const folder = path.join(import.meta.dirname, teammate.kind);
    for (const file of ["teammate.ts", "work.ts", "graph.ts"]) assert.ok(existsSync(path.join(folder, file)), `${teammate.kind} has no ${file}`);
  }
});

test("a definition that lists a tool twice, or has a kind that is not a plain word, is refused", () => {
  const base = TEAMMATES[0];
  assert.throws(() => defineTeammate({ ...base, tools: ["memory.read", "memory.read"] }), /lists a tool twice/);
  assert.throws(() => defineTeammate({ ...base, kind: "Pay Run" }), /lowercase words/);
});

test("startup gives each company every teammate once, and keeps what a person changed", async () => {
  await pool.query("UPDATE teammates SET daily_budget_usd = 9, name = 'Our invoices' WHERE company = 'bramble' AND id = 'invoices'");
  assert.equal(await ensureTeammates(pool), 0);
  const { rows } = await pool.query("SELECT id, kind, name, daily_budget_usd FROM teammates WHERE company = 'bramble' ORDER BY id");
  assert.deepEqual(rows.map((row) => row.kind).sort(), TEAMMATES.map((teammate) => teammate.kind).sort());
  const invoices = rows.find((row) => row.id === "invoices");
  assert.equal(invoices.name, "Our invoices");
  assert.equal(Number(invoices.daily_budget_usd), 9);
});

test("a teammate whose kind has no code hands its events to a person instead of leaving them waiting", async () => {
  await pool.query("INSERT INTO teammates (company, id, kind, name) VALUES ('bramble', 'orphan', 'retired-kind', 'Orphan')");
  const inbox = new Inbox(pool);
  await inbox.receive({ company: "bramble", teammate: "orphan", source: "lmail", sourceId: "m-1", type: "mail.received", payload: {} });
  // No gateway call happens: the run has no code to make one.
  const settled = await workInbox({ pool, gateway: {} as GatewayClient, kinds: {} }, inbox, "bramble", "orphan");
  assert.equal(settled?.stop, "handed_to_human");
  const { rows } = await pool.query("SELECT status FROM inbox_events WHERE teammate = 'orphan'");
  assert.deepEqual(rows.map((row) => row.status), ["done"]);
  const run = await pool.query("SELECT summary FROM runs WHERE id = $1", [settled?.runId]);
  assert.match(run.rows[0].summary, /no teammate code for the kind "retired-kind"/);
});
