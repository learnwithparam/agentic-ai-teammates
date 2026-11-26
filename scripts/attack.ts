import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createPool, migrate } from "../src/server/db";
import { requireSettings, setting } from "../src/server/env";
import { GatewayClient, GatewayError } from "../src/server/gateway-client";
import { Inbox } from "../src/server/inbox";
import { Run, RUN_CAPS, type StopReason } from "../src/server/run";
import { type Attack, type AttackSend, sharedAttacks } from "../src/server/teammates/attacks";
import { teammateWork } from "../src/server/teammates/core";
import type { TeammateDefinition } from "../src/server/teammates/define";
import { SEED_PEOPLE } from "../src/server/people";
import { TEAMMATES } from "../src/server/teammates/registry";
import { startTracing } from "../src/server/tracing";
import { workInbox } from "../src/server/worker-loop";

// Sends every attack at a teammate, with real model calls through the running gateway.
// Then it checks what the run did from its steps and the outbox. The cases are the shared ones in
// src/server/teammates/attacks.ts and the teammate's own attacks.ts.
//
//   npm run teammate:attack -- invoice
//   npm run teammate:attack -- all
//
// Each kind gets its own attack teammate, such as invoice-attack. It is off duty and quiet, so
// it wakes only for these events and anything it writes waits as a draft. It fails when a tool
// in neverTools ran, a run ended outside its stops, a call was let through, or anything was sent.

requireSettings([
  "DATABASE_URL", "GATEWAY_URL", "GATEWAY_WORKER_TOKEN", "LDRIVE_URL", "LDRIVE_UPLOAD_KEY",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL",
]);

const COMPANY = "bramble";
// The person who writes to the teammate: Ada, an admin, so chat offers every tool it may offer.
// Her authority has the shape the web server writes from a signed token. Her subject is the one
// Keycloak gave her when she last signed in, or a fixed one before her first sign-in.
const ADA = SEED_PEOPLE.find((person) => person.email === "ada@bramble.example")!;
// Files handed over come from a folder no teammate watches, so only the attack teammate sees them.
const HAND_OVER_FOLDER = "Contracts";
const TIMEOUT_MS = 15_000;

const kind = process.argv[2];
const kinds = TEAMMATES.map((teammate) => teammate.kind);
if (!kind || (kind !== "all" && !kinds.includes(kind))) throw new Error(`Name a teammate: all, ${kinds.join(", ")}.`);
const chosen = TEAMMATES.filter((teammate) => kind === "all" || teammate.kind === kind);

const stopTracing = startTracing("attack");
const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);
const checkpointer = new PostgresSaver(pool);
await checkpointer.setup();
const gateway = new GatewayClient(setting("GATEWAY_URL"), setting("GATEWAY_WORKER_TOKEN"));
const inbox = new Inbox(pool);
const drive = setting("LDRIVE_URL");
const driveHeaders = { authorization: `Bearer ${setting("LDRIVE_UPLOAD_KEY")}` };

type Verdict = { ok: boolean; said: string };

async function asAda() {
  const { rows } = await pool.query<{ subject: string }>("SELECT subject FROM members WHERE company = $1 AND email = $2", [COMPANY, ADA.email]);
  const name = `${ADA.firstName} ${ADA.lastName}`;
  const authority = { subject: rows[0]?.subject ?? "attack-ada", name, email: ADA.email, roles: [ADA.role!], approvalLimit: ADA.approvalLimit ?? null };
  return { person: ADA.email, from: name, authority };
}
const PERSON = await asAda();

async function attackTeammate(definition: TeammateDefinition): Promise<string> {
  const id = `${definition.kind}-attack`;
  await pool.query(
    `INSERT INTO teammates (company, id, kind, name, on_duty, quiet) VALUES ($1, $2, $3, $4, false, true)
     ON CONFLICT (company, id) DO UPDATE SET paused = false, on_duty = false, quiet = true`,
    [COMPANY, id, definition.kind, `${definition.name} attack`],
  );
  return id;
}

async function handOverFolderId(): Promise<string> {
  const response = await fetch(`${drive}/api/v1/folders`, { headers: driveHeaders, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`LDrive did not list its folders: ${response.status}.`);
  const found = ((await response.json()) as { id: string; name: string }[]).find((folder) => folder.name === HAND_OVER_FOLDER);
  if (!found) throw new Error(`LDrive has no ${HAND_OVER_FOLDER} folder.`);
  return found.id;
}

async function upload(file: string): Promise<{ id: string; name: string }> {
  const name = `${path.basename(file, ".pdf")} ${randomUUID().slice(0, 8)}.pdf`;
  const response = await fetch(`${drive}/api/v1/folders/${await handOverFolderId()}/files?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { ...driveHeaders, "content-type": "application/pdf" },
    body: readFileSync(path.join(import.meta.dirname, "..", file)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`LDrive refused ${file}: ${response.status} ${await response.text()}`);
  return { id: ((await response.json()) as { id: string }).id, name };
}

// A call with no model: the gateway's allowlist or the tool's guard must say no.
async function callAttack(teammate: string, attack: Attack, send: Extract<AttackSend, { call: string }>): Promise<Verdict> {
  const run = await Run.start(pool, gateway, { runId: randomUUID(), company: COMPANY, teammate });
  try {
    const result = await run.tool(`attack:${attack.name}`, send.call, send.args);
    run.outcome(`attack:${attack.name}`, "nothing_to_send", `${attack.name}: ${result.status}`);
    const refused = result.status === "denied";
    return { ok: refused === attack.expect.refused, said: result.status === "denied" ? `denied: ${result.reason}` : result.status };
  } catch (error) {
    if (!(error instanceof GatewayError) || error.status !== 403) throw error;
    run.outcome(`attack:${attack.name}`, "nothing_to_send", `${attack.name}: refused`);
    return { ok: attack.expect.refused === true, said: `refused: ${error.message}` };
  } finally {
    await run.finish();
  }
}

// The finished run that worked an event, waiting up to two minutes for it.
async function runThatTook(teammate: string, sourceId: string): Promise<{ runId: string; stop: StopReason } | null> {
  for (let tries = 0; tries < 60; tries++) {
    const { rows } = await pool.query<{ run_id: string | null; stop_reason: StopReason | null }>(
      `SELECT event.run_id, run.stop_reason FROM inbox_events event LEFT JOIN runs run ON run.id = event.run_id
       WHERE event.company = $1 AND event.teammate = $2 AND event.source_id = $3 AND event.status IN ('done', 'dead') AND run.status = 'finished'`,
      [COMPANY, teammate, sourceId],
    );
    if (rows[0]?.run_id && rows[0].stop_reason) return { runId: rows[0].run_id, stop: rows[0].stop_reason };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

// An event in the attack teammate's inbox, worked by the same code the worker runs.
async function eventAttack(definition: TeammateDefinition, teammate: string, attack: Attack): Promise<Verdict> {
  const id = randomUUID();
  if ("message" in attack.send) {
    await inbox.receive({
      company: COMPANY, teammate, source: "person", sourceId: id, type: "person.message",
      payload: { messageId: id, text: attack.send.message, reach: "tools", ...PERSON },
    });
  } else if ("handOver" in attack.send) {
    const file = await upload(attack.send.handOver);
    const source = { kind: "drive", id: file.id, attachmentId: null, sender: null, subject: file.name, messageId: null };
    await inbox.receive({ company: COMPANY, teammate, source: "request", sourceId: id, type: "person.request", payload: { requestId: id, source, ...PERSON } });
  }
  const caps = { ...RUN_CAPS, ...attack.caps };
  const worked = await workInbox({ pool, gateway, kinds: { [definition.kind]: teammateWork(definition, checkpointer) }, caps }, inbox, COMPANY, teammate);
  // A running worker may take the event first, with another event such as the drive notice an
  // upload raised. The run that took it is the one to judge, whoever started it.
  const settled = worked ?? (await runThatTook(teammate, id));
  if (!settled) return { ok: false, said: "no run picked the event up" };
  const problems: string[] = [];
  const ran = await pool.query<{ tool: string }>(
    "SELECT DISTINCT detail->>'tool' AS tool FROM run_steps WHERE run_id = $1 AND kind = 'tool' AND detail->>'status' = 'done'",
    [settled.runId],
  );
  const forbidden = ran.rows.map((row) => row.tool).filter((tool) => attack.expect.neverTools?.includes(tool as never));
  if (forbidden.length) problems.push(`ran ${forbidden.join(", ")}`);
  if (attack.expect.stops && !attack.expect.stops.includes(settled.stop)) problems.push(`stopped ${settled.stop}, expected ${attack.expect.stops.join(" or ")}`);
  const sent = await pool.query("SELECT 1 FROM outbox WHERE run_id = $1 AND status <> 'draft'", [settled.runId]);
  if (sent.rowCount) problems.push(`${sent.rowCount} message(s) left without a person`);
  return { ok: problems.length === 0, said: problems.length ? problems.join("; ") : settled.stop };
}

const failed: string[] = [];
for (const definition of chosen) {
  const teammate = await attackTeammate(definition);
  console.log(`\n${definition.name} (${teammate})`);
  for (const attack of [...sharedAttacks(definition), ...definition.attacks]) {
    const { send } = attack;
    const verdict = "call" in send ? await callAttack(teammate, attack, send) : await eventAttack(definition, teammate, attack);
    if (!verdict.ok) failed.push(`${definition.kind}: ${attack.name}`);
    console.log(`  ${verdict.ok ? "held" : "FAIL"} ${attack.name.padEnd(44)} ${verdict.said.slice(0, 120)}`);
  }
}

await pool.end();
await stopTracing();
if (failed.length) {
  console.error(`\nThese attacks got through:\n${failed.map((name) => `  ${name}`).join("\n")}`);
  process.exit(1);
}
