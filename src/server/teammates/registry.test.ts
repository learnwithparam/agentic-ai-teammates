import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import type { GatewayClient } from "../gateway-client";
import { Inbox } from "../inbox";
import { testDatabase } from "../test-database";
import { TOOLS } from "../tools";
import { workInbox } from "../worker-loop";
import { sharedAttacks } from "./attacks";
import { defineTeammate } from "./define";
import { ensureHarnessTeammate, ensureTeammates } from "./ensure";
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
    // Every teammate is scored before anyone turns Quiet off.
    assert.ok(existsSync(path.join(import.meta.dirname, "../../..", teammate.evaluate)), `${teammate.kind}'s eval ${teammate.evaluate} is missing`);
    // The board shows the purpose, and the conversation offers the questions. Choosing a teammate
    // with neither once left Mission Control blank.
    assert.ok(teammate.purpose.length > 0 && teammate.asks.length > 0, `${teammate.kind} has no purpose or no questions to offer`);
    // Every teammate faces the shared attacks and at least one of its own.
    assert.ok(teammate.attacks.length > 0, `${teammate.kind} has no attacks of its own`);
    const all = [...sharedAttacks(teammate), ...teammate.attacks];
    assert.equal(new Set(all.map((attack) => attack.name)).size, all.length, `${teammate.kind} has two attacks with one name`);
    for (const attack of all) {
      for (const tool of attack.expect.neverTools ?? []) assert.ok(teammate.tools.includes(tool), `${attack.name}: ${tool} is not ${teammate.kind}'s tool`);
      if ("handOver" in attack.send) assert.ok(existsSync(path.join(import.meta.dirname, "../../..", attack.send.handOver)), `${attack.name}: ${attack.send.handOver} is missing`);
      if ("call" in attack.send) assert.equal(attack.expect.refused, true, `${attack.name} calls a tool, so it must expect a refusal`);
    }
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

// An ask needs two lists to agree: the asker lists team.ask_teammate, and the teammate asked
// names the asker's kind. One without the other is a hand-off that is refused on the day it is needed.
test("every kind a teammate takes asks from exists and may ask, and every teammate that asks has someone to ask", () => {
  const takers = TEAMMATES.flatMap((teammate) => (teammate.takesAsksFrom ?? []).map((kind) => ({ taker: teammate.kind, kind })));
  for (const { taker, kind } of takers) {
    const asker = TEAMMATES.find((teammate) => teammate.kind === kind);
    assert.ok(asker, `${taker} takes asks from ${kind}, which is not a teammate`);
    assert.ok(asker.tools.includes("team.ask_teammate"), `${taker} takes asks from ${kind}, which does not list team.ask_teammate`);
  }
  for (const teammate of TEAMMATES.filter((each) => each.tools.includes("team.ask_teammate"))) {
    assert.ok(takers.some((each) => each.kind === teammate.kind), `${teammate.kind} lists team.ask_teammate, but no teammate takes its asks`);
  }
});

test("a harness teammate starts each script run with no card of its own still waiting", async () => {
  await ensureHarnessTeammate(pool, { company: "bramble", id: "invoice-attack", kind: "invoice", name: "Invoice attack" });
  const card = (id: string, teammate: string) =>
    pool.query(
      `INSERT INTO approvals (id, company, teammate, run_id, thread_id, tool, args, payload_hash, title, brief)
       VALUES ($1, 'bramble', $2, $3, 't', 'books.post_bill', '{}', 'h', 'Post a bill', 'Brief')`,
      [id, teammate, randomUUID()],
    );
  const own = randomUUID();
  const real = randomUUID();
  await card(own, "invoice-attack");
  await card(real, "invoices");
  await ensureHarnessTeammate(pool, { company: "bramble", id: "invoice-attack", kind: "invoice", name: "Invoice attack" });
  const { rows } = await pool.query("SELECT id, status FROM approvals WHERE id = ANY($1)", [[own, real]]);
  const status = Object.fromEntries(rows.map((row) => [row.id, row.status]));
  assert.equal(status[own], "denied");
  assert.equal(status[real], "pending", "a real teammate's card is never closed by a script");
});
