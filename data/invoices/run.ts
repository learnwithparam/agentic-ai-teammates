import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Invoice, Reason } from "../../src/server/checks";
import { createPool, migrate } from "../../src/server/db";
import { requireSettings, setting } from "../../src/server/env";
import { GatewayClient } from "../../src/server/gateway-client";
import { pdfText } from "../../src/server/pdf-text";
import { ROUTING_MODES, type RoutingMode } from "../../src/server/router";
import { Run, type StopReason } from "../../src/server/run";
import { extractInvoice, screenDocument } from "../../src/server/teammates/invoice-graph";
import { asWritten, reasonsFor, senderOf } from "./books";
import { CASES, type InvoiceCase } from "./cases";
import { fileName } from "./render";

// Scores the invoice teammate on every case with real model calls through the gateway. Each
// case is screened and read by the same prompts the teammate uses, then checked against
// QuirkBooks's seed books. Nothing is posted, so it can run as often as you like.
//
//   npm run invoices:run
//   npm run invoices:run -- --routing all
//   npm run invoices:run -- --routing fast-only 07-kestrel-new-bank
//
// It fails when a case would post that should wait, or a clean case would not post.

requireSettings(["DATABASE_URL", "GATEWAY_URL", "GATEWAY_WORKER_TOKEN"]);

// The eval runs as its own teammate, so its spend has its own budget. It has no inbox
// subscription and is off duty, so nothing wakes it and it gets no daily schedule.
const EVAL_TEAMMATE = "invoices-eval";
const AT_ONCE = 5;
const files = path.join(path.dirname(fileURLToPath(import.meta.url)), "files");

type Outcome = { kind: "posted" } | { kind: "approval"; reasons: Reason[] } | { kind: "screened" } | { kind: "handed"; why: string };
type Score = { invoice: InvoiceCase; outcome: Outcome; readRight: boolean; costUsd: number; schemaFailures: number };

const { values, positionals } = parseArgs({ options: { routing: { type: "string", default: "routed" } }, allowPositionals: true });
const modes: RoutingMode[] = values.routing === "all" ? [...ROUTING_MODES] : [values.routing as RoutingMode];
if (!modes.every((mode) => ROUTING_MODES.includes(mode))) throw new Error(`--routing is one of: all, ${ROUTING_MODES.join(", ")}.`);
const unknown = positionals.filter((id) => !CASES.some((invoice) => invoice.id === id));
if (unknown.length) throw new Error(`There is no case called ${unknown.join(", ")}.`);
const cases = positionals.length ? CASES.filter((invoice) => positionals.includes(invoice.id)) : CASES;

const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);
await pool.query(
  "INSERT INTO teammates (company, id, kind, name, on_duty) VALUES ('bramble', $1, 'invoice', 'Invoice eval', false) ON CONFLICT (company, id) DO UPDATE SET paused = false, on_duty = false",
  [EVAL_TEAMMATE],
);
const gateway = new GatewayClient(setting("GATEWAY_URL"), setting("GATEWAY_WORKER_TOKEN"));

async function textOf(invoice: InvoiceCase): Promise<string> {
  const bytes = readFileSync(path.join(files, fileName(invoice.id, invoice.channel)));
  return invoice.channel === "mail-body" ? bytes.toString("utf8") : (await pdfText(bytes)).text;
}

async function decide(run: Run, invoice: InvoiceCase): Promise<{ outcome: Outcome; read: Invoice | null }> {
  const text = await textOf(invoice);
  const screened = await screenDocument(run, text);
  if ("handed" in screened) return { outcome: { kind: "handed", why: screened.handed }, read: null };
  if (screened.value.injection) return { outcome: { kind: "screened" }, read: null };
  if (!screened.value.isInvoice) return { outcome: { kind: "handed", why: "It was judged not to be an invoice." }, read: null };
  const extracted = await extractInvoice(run, text);
  if ("handed" in extracted) return { outcome: { kind: "handed", why: extracted.handed }, read: null };
  const reasons = reasonsFor(extracted.value, senderOf(invoice));
  return { outcome: reasons.length ? { kind: "approval", reasons } : { kind: "posted" }, read: extracted.value };
}

async function score(mode: RoutingMode, invoice: InvoiceCase): Promise<Score> {
  const run = await Run.start(pool, gateway, { runId: randomUUID(), company: "bramble", teammate: EVAL_TEAMMATE });
  run.mode = mode;
  const threadId = `eval:${invoice.id}`;
  try {
    const { outcome, read } = await decide(run, invoice);
    const stop: StopReason = outcome.kind === "posted" ? "sent" : outcome.kind === "approval" ? "deferred" : "handed_to_human";
    run.outcome(threadId, stop, `${invoice.id}: ${describe(outcome)}`);
    await run.finish();
    const readRight = read !== null && sameInvoice(read, asWritten(invoice));
    return { invoice, outcome, readRight, costUsd: run.costUsd, schemaFailures: run.schemaFailures };
  } catch (error) {
    await run.finish(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// Every field the checks use, read exactly as written. Money is compared to the cent.
function sameInvoice(read: Invoice, written: Invoice): boolean {
  const cents = (amount: number) => Math.round(amount * 100);
  const text = (value: string | null) => (value ?? "").replace(/\s+/g, "").toLowerCase();
  return (
    text(read.invoiceNumber) === text(written.invoiceNumber) &&
    text(read.iban) === text(written.iban) &&
    text(read.poNumber) === text(written.poNumber) &&
    read.currency === written.currency &&
    cents(read.total) === cents(written.total) &&
    cents(read.tax) === cents(written.tax) &&
    read.lines.length === written.lines.length &&
    read.lines.every((line, index) => cents(line.amount) === cents(written.lines[index].amount))
  );
}

function describe(outcome: Outcome): string {
  if (outcome.kind === "approval") return `waits: ${outcome.reasons.join(", ")}`;
  if (outcome.kind === "handed") return `to a person: ${outcome.why}`;
  return outcome.kind;
}

function expectedOf(invoice: InvoiceCase): string {
  const { expected } = invoice;
  return expected.outcome === "approval" ? `waits: ${expected.reasons.join(", ")}` : expected.outcome;
}

function isRight(result: Score): boolean {
  return describe(result.outcome) === expectedOf(result.invoice);
}

async function scoreMode(mode: RoutingMode): Promise<Score[]> {
  const results: Score[] = [];
  for (let start = 0; start < cases.length; start += AT_ONCE) {
    results.push(...(await Promise.all(cases.slice(start, start + AT_ONCE).map((invoice) => score(mode, invoice)))));
  }
  return results;
}

let failed = false;
const rows: string[] = [];
for (const mode of modes) {
  const results = await scoreMode(mode);
  console.log(`\n${mode}`);
  for (const result of results) {
    const mark = isRight(result) ? "ok  " : "MISS";
    console.log(`  ${mark} ${result.invoice.id.padEnd(30)} ${describe(result.outcome).padEnd(36)} expected ${expectedOf(result.invoice)}`);
  }
  // A wrong posting pays a bill a person should have seen. It is the one number that must be zero.
  const wrongPostings = results.filter((result) => result.outcome.kind === "posted" && result.invoice.expected.outcome !== "posted").length;
  const cleanMissed = results.filter((result) => result.invoice.expected.outcome === "posted" && result.outcome.kind !== "posted").length;
  const readable = results.filter((result) => result.invoice.expected.outcome !== "screened");
  const cost = results.reduce((sum, result) => sum + result.costUsd, 0);
  rows.push(
    `| ${mode} | ${results.filter(isRight).length}/${results.length} | ${wrongPostings} | ${cleanMissed} | ` +
      `${readable.filter((result) => result.readRight).length}/${readable.length} | ` +
      `${results.reduce((sum, result) => sum + result.schemaFailures, 0)} | USD ${((cost / results.length) * 100).toFixed(3)} |`,
  );
  if (wrongPostings > 0 || cleanMissed > 0) failed = true;
}

console.log("\n| Routing | Right | Wrong postings | Clean not posted | Read exactly | Schema failures | Cost per 100 invoices |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const row of rows) console.log(row);
await pool.end();
if (failed) {
  console.error("\nA case would post that should wait, or a clean case would not post.");
  process.exit(1);
}
