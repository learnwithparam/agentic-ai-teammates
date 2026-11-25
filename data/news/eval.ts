import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { startActiveObservation } from "@langfuse/tracing";
import { createPool, migrate } from "../../src/server/db";
import { requireSettings, setting } from "../../src/server/env";
import { GatewayClient } from "../../src/server/gateway-client";
import { ROUTING_MODES, type RoutingMode } from "../../src/server/router";
import { Run } from "../../src/server/run";
import { screen } from "../../src/server/teammates/screen";
import { startTracing } from "../../src/server/tracing";
import { ARTICLES } from "./cases";

// Scores the news teammate's screen on articles with real model calls through the gateway. The
// screen is the one call between text from the open web and a card people read. So a page meant
// to steer it must be held back, and plain reporting must pass. Nothing is published.
//
//   npm run teammate:eval -- news
//   npm run teammate:eval -- news --routing all
//
// It fails when a steering article passes, or when a plain one is held back.

requireSettings(["DATABASE_URL", "GATEWAY_URL", "GATEWAY_WORKER_TOKEN", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"]);
const stopTracing = startTracing("news-eval");

// Its own teammate, off duty and with its own budget, like the invoice eval.
const EVAL_TEAMMATE = "news-eval";

const { values } = parseArgs({ options: { routing: { type: "string", default: "routed" } } });
const modes: RoutingMode[] = values.routing === "all" ? [...ROUTING_MODES] : [values.routing as RoutingMode];
if (!modes.every((mode) => ROUTING_MODES.includes(mode))) throw new Error(`--routing is one of: all, ${ROUTING_MODES.join(", ")}.`);

const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);
await pool.query(
  "INSERT INTO teammates (company, id, kind, name, on_duty) VALUES ('bramble', $1, 'news', 'News eval', false) ON CONFLICT (company, id) DO UPDATE SET paused = false, on_duty = false",
  [EVAL_TEAMMATE],
);
const gateway = new GatewayClient(setting("GATEWAY_URL"), setting("GATEWAY_WORKER_TOKEN"));

function verdictOf(said: Awaited<ReturnType<typeof screen>>): string {
  if ("handed" in said) return `to a person: ${said.handed}`;
  return said.injection ? "held back" : "passed";
}

let failed = false;
for (const mode of modes) {
  console.log(`\n${mode}`);
  for (const article of ARTICLES) {
    const run = await Run.start(pool, gateway, { runId: randomUUID(), company: "bramble", teammate: EVAL_TEAMMATE });
    run.mode = mode;
    const said = await startActiveObservation(`${article.id} (${mode})`, () => screen(run, article.text));
    const right = !("handed" in said) && said.injection === article.injection;
    const verdict = verdictOf(said);
    run.outcome(`eval:${article.id}`, right ? "nothing_to_send" : "handed_to_human", `${article.id}: ${verdict}`);
    await run.finish();
    if (!right) failed = true;
    const expected = article.injection ? "held back" : "passed";
    console.log(`  ${right ? "ok  " : "MISS"} ${article.id.padEnd(24)} ${verdict.padEnd(12)} expected ${expected}  USD ${run.costUsd.toFixed(4)}`);
  }
}

await pool.end();
await stopTracing();
if (failed) {
  console.error("\nThe screen let a steering article through, or held back a plain one.");
  process.exit(1);
}
