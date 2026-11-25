import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import { z } from "zod";
import type { InboxEvent } from "../../inbox";
import { COMPANIES } from "../../people";
import { CapReached, type Run } from "../../run";
import { type Decision, FRESH_STATE, newsGraph, type Result } from "./graph";
import { companyDay } from "../timed";

// The news teammate. Its "edition" timer starts the day's graph, one thread per day, and an
// approval decision resumes the day that asked. The core handles its chat and shared timers.

export const EDITION_TIMER = "edition";

const Fired = z.object({ name: z.string(), firedFor: z.iso.datetime() });
const DecidedPayload = z.object({ approvalId: z.string(), threadId: z.string(), status: z.enum(["approved", "denied"]) });

type Work = { threadId: string; start: { day: string } } | { threadId: string; resume: Decision };

export function newsThread(day: string): string {
  return `news:${day}`;
}

export function newsTeammate(checkpointer: BaseCheckpointSaver) {
  const runs = new Map<string, Run>();
  const graph = newsGraph(checkpointer, (runId) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`Run ${runId} is not running in this worker.`);
    return run;
  });

  return async function work(run: Run, batch: InboxEvent[]) {
    runs.set(run.ref.runId, run);
    try {
      // The core already handled chat and the shared timers, so the batch is editions and decisions.
      const editions = batch.filter((event) => event.type === "timer.fired" && Fired.parse(event.payload).name === EDITION_TIMER);
      const events = batch.filter((event) => !editions.includes(event));
      for (const item of plan(run, editions, events)) {
        try {
          const result = await runThread(run, item);
          if (result) run.outcome(item.threadId, result.outcome, result.note);
        } catch (error) {
          if (!(error instanceof CapReached)) throw error;
          // The day keeps its checkpoint. The next edition timer for the same day carries on from it.
          run.outcome(item.threadId, "handed_to_human", error.message);
          return;
        }
      }
    } finally {
      runs.delete(run.ref.runId);
    }
  };

  async function runThread(run: Run, item: Work): Promise<Result | null> {
    const config = { configurable: { thread_id: item.threadId, run_id: run.ref.runId }, recursionLimit: 30 };
    const state = await graph.getState(config);
    if ("start" in item) {
      // A day that finished, or waits for a person, is never started again, so it publishes once.
      if (state.values?.day && (state.next.length === 0 || state.next.includes("wait"))) return null;
      if (state.values?.day) await graph.invoke(null, config);
      else await graph.invoke({ day: item.start.day, ...FRESH_STATE }, config);
    } else if (state.next.length > 0 && !state.next.includes("wait")) {
      await graph.invoke(null, config);
    } else {
      if (!state.next.includes("wait")) {
        await run.note("note", "A decision arrived for a day that is not waiting", { threadId: item.threadId });
        return null;
      }
      await graph.invoke(new Command({ resume: item.resume }), config);
    }
    const after = await graph.getState(config);
    if (after.next.includes("wait")) return { outcome: "deferred", note: `The news for ${after.values.day} waits for a person.` };
    return after.values.result ?? null;
  }
}

function plan(run: Run, editions: InboxEvent[], events: InboxEvent[]): Work[] {
  const timezone = COMPANIES[run.ref.company].timezone;
  const work: Work[] = [];
  const days = new Set<string>();
  for (const event of editions) {
    const day = companyDay(new Date(Fired.parse(event.payload).firedFor), timezone);
    // Two firings for one day in a batch are one edition.
    if (days.has(day)) continue;
    days.add(day);
    work.push({ threadId: newsThread(day), start: { day } });
  }
  for (const event of events.filter((event) => event.type === "approval.decided")) {
    const decided = DecidedPayload.parse(event.payload);
    work.push({ threadId: decided.threadId, resume: { status: decided.status, approvalId: decided.approvalId } });
  }
  return work;
}
