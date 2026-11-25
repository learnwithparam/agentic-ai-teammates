import { randomUUID } from "node:crypto";
import { getActiveTraceId, propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import type { Pool } from "pg";
import type { GatewayClient } from "./gateway-client";
import { type InboxEvent, Inbox } from "./inbox";
import { Run, type RunCaps, RUN_CAPS, type StopReason } from "./run";

// The worker's loop: find an inbox with work, claim a batch, run its teammate, and settle the
// batch. Each step is a plain function so the tests drive it against a real Postgres.

export type Teammate = (run: Run, events: InboxEvent[]) => Promise<void>;
export type Kinds = Record<string, Teammate>;

export type WorkerOptions = { pool: Pool; gateway: GatewayClient; kinds: Kinds; caps?: RunCaps; inbox?: Inbox };

export type Settled = { company: string; teammate: string; runId: string; stop: StopReason; events: number };

// One pass over every inbox that has work now. Returns what each run ended with.
export async function workOnce(options: WorkerOptions): Promise<Settled[]> {
  const inbox = options.inbox ?? new Inbox(options.pool);
  const settled: Settled[] = [];
  await inbox.endAbandonedRuns();
  for (const ready of await inbox.readyInboxes()) {
    const done = await workInbox(options, inbox, ready.company, ready.teammate);
    if (done) settled.push(done);
  }
  return settled;
}

export async function workInbox(options: WorkerOptions, inbox: Inbox, company: string, teammate: string): Promise<Settled | null> {
  const { pool, gateway } = options;
  const kind = await kindOf(pool, company, teammate);
  if (!kind) return null;
  const runId = randomUUID();
  const events = await inbox.claim(company, teammate, runId);
  if (!events) return null;
  const work = options.kinds[kind] ?? noCodeFor(kind);

  return propagateAttributes({ sessionId: runId, userId: `${company}/${teammate}` }, () =>
    startActiveObservation(`${teammate} run`, async (span) => {
      span.update({ input: events.map((event) => ({ type: event.type, source: event.source, sourceId: event.sourceId })) });
      const run = await Run.start(pool, gateway, { runId, company, teammate }, options.caps ?? RUN_CAPS);
      await pool.query("UPDATE runs SET trace_id = $2 WHERE id = $1", [runId, getActiveTraceId() ?? null]);
      // The lease is renewed while the run works, so a long run is not taken by a second worker.
      const renewal = setInterval(() => void inbox.renew(runId).catch(() => {}), 30_000);
      try {
        await work(run, events);
        const stop = await run.finish();
        await inbox.complete(runId);
        span.update({ output: { stop } });
        return { company, teammate, runId, stop, events: events.length };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "The run failed.";
        console.error(`Run ${runId} for ${company}/${teammate} failed:`, error);
        await run.finish(reason.slice(0, 500));
        await inbox.fail(runId, reason.slice(0, 500));
        span.update({ level: "ERROR", statusMessage: reason, output: { stop: "failed" } });
        return { company, teammate, runId, stop: "failed" as const, events: events.length };
      } finally {
        clearInterval(renewal);
      }
    }),
  );
}

// A teammate row whose kind has no code would leave its events waiting forever. Instead its run
// ends handed to a person, saying why, and its events are settled.
function noCodeFor(kind: string): Teammate {
  return async (run, events) => {
    for (const event of events) run.outcome(`event:${event.id}`, "handed_to_human", `There is no teammate code for the kind "${kind}", so nothing read this ${event.type} event.`);
  };
}

async function kindOf(pool: Pool, company: string, teammate: string): Promise<string | null> {
  const { rows } = await pool.query<{ kind: string }>("SELECT kind FROM teammates WHERE company = $1 AND id = $2", [company, teammate]);
  return rows[0]?.kind ?? null;
}
