import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import { z } from "zod";
import type { InboxEvent } from "../../inbox";
import { COMPANIES } from "../../people";
import { CapReached, type Run } from "../../run";
import { companyDay } from "../timed";
import { type Decision, FRESH_STATE, paymentsGraph, type Result } from "./graph";

// The payments teammate. Its "pay-run" timer starts the day's graph, one thread per day, and an
// approval decision resumes the day that asked. The core handles its chat and shared timers.

export const PAY_RUN_TIMER = "pay-run";

const Fired = z.object({ name: z.string(), firedFor: z.iso.datetime() });
const DecidedPayload = z.object({ approvalId: z.string(), threadId: z.string(), status: z.enum(["approved", "denied"]) });

type Work = { threadId: string; start: { day: string } } | { threadId: string; resume: Decision };

export function payRunThread(day: string): string {
  return `payments:${day}`;
}

export function paymentsTeammate(checkpointer: BaseCheckpointSaver) {
  const runs = new Map<string, Run>();
  const graph = paymentsGraph(
    checkpointer,
    (runId) => {
      const run = runs.get(runId);
      if (!run) throw new Error(`Run ${runId} is not running in this worker.`);
      return run;
    },
    (company) => COMPANIES[company].currency,
  );

  return async function work(run: Run, batch: InboxEvent[]) {
    runs.set(run.ref.runId, run);
    try {
      for (const item of plan(run, batch)) {
        try {
          const result = await runThread(run, item);
          if (result) run.outcome(item.threadId, result.outcome, result.note);
        } catch (error) {
          if (!(error instanceof CapReached)) throw error;
          // The day keeps its checkpoint. The next pay-run timer for the same day carries on from it.
          run.outcome(item.threadId, "handed_to_human", error.message);
          return;
        }
      }
    } finally {
      runs.delete(run.ref.runId);
    }
  };

  async function runThread(run: Run, item: Work): Promise<Result | null> {
    const config = { configurable: { thread_id: item.threadId, run_id: run.ref.runId }, recursionLimit: 20 };
    const state = await graph.getState(config);
    if ("start" in item) {
      // A day that finished, or waits for a person, is never started again, so it pays once.
      if (state.values?.day && (state.next.length === 0 || state.next.includes("wait"))) return null;
      if (state.values?.day) await graph.invoke(null, config);
      else await graph.invoke({ day: item.start.day, ...FRESH_STATE }, config);
    } else if (state.next.length > 0 && !state.next.includes("wait")) {
      // A run that stopped part way, before the card, carries on from its last step.
      await graph.invoke(null, config);
    } else {
      if (!state.next.includes("wait")) {
        await run.note("note", "A decision arrived for a pay run that is not waiting", { threadId: item.threadId });
        return null;
      }
      await graph.invoke(new Command({ resume: item.resume }), config);
    }
    const after = await graph.getState(config);
    if (after.next.includes("wait")) return { outcome: "deferred", note: `The pay run for ${after.values.day} waits for a person.` };
    return after.values.result ?? null;
  }
}

function plan(run: Run, batch: InboxEvent[]): Work[] {
  const timezone = COMPANIES[run.ref.company].timezone;
  const work: Work[] = [];
  const days = new Set<string>();
  for (const event of batch) {
    if (event.type === "timer.fired") {
      const fired = Fired.parse(event.payload);
      if (fired.name !== PAY_RUN_TIMER) continue;
      const day = companyDay(new Date(fired.firedFor), timezone);
      // Two firings for one day in a batch are one pay run.
      if (days.has(day)) continue;
      days.add(day);
      work.push({ threadId: payRunThread(day), start: { day } });
    } else if (event.type === "approval.decided") {
      const decided = DecidedPayload.parse(event.payload);
      work.push({ threadId: decided.threadId, resume: { status: decided.status, approvalId: decided.approvalId } });
    }
  }
  return work;
}
