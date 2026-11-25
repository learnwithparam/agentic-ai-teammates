import { z } from "zod";
import type { InboxEvent } from "../inbox";
import { COMPANIES } from "../people";
import type { Run } from "../run";

// What every teammate does when one of its timers fires. A reminder and a digest are the same for
// each teammate, so the teammate's own graph only sees the events that are its real work.

const Queued = z.object({ queued: z.number().int() });
const Fired = z.object({ name: z.string(), firedFor: z.iso.datetime(), approvalId: z.uuid().optional() });

// The day a firing belongs to, on the company's clock, as YYYY-MM-DD.
export function companyDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// Handles the timer events in a batch and returns the rest for the teammate's own work.
export async function handleTimers(run: Run, events: InboxEvent[]): Promise<InboxEvent[]> {
  const rest: InboxEvent[] = [];
  for (const event of events) {
    if (event.type !== "timer.fired") {
      rest.push(event);
      continue;
    }
    const fired = Fired.parse(event.payload);
    const thread = `timer:${fired.name}`;
    if (fired.name.startsWith("remind:") && fired.approvalId) {
      const result = await run.tool(thread, "team.remind", { approvalId: fired.approvalId });
      if (result.status !== "done") run.outcome(thread, "handed_to_human", result.status === "denied" ? result.reason : "The reminder asked for an approval.");
      else if (Queued.parse(result.result).queued === 0) run.outcome(thread, "nothing_to_send", "The approval was decided before the reminder.");
      else run.outcome(thread, "sent", "Reminded the people who decide.");
    } else if (fired.name === "digest") {
      const day = companyDay(new Date(fired.firedFor), COMPANIES[run.ref.company].timezone);
      const result = await run.tool(thread, "team.digest", { day });
      run.outcome(thread, result.status === "done" ? "sent" : "handed_to_human", result.status === "denied" ? result.reason : `Sent the summary for ${day}.`);
    } else {
      // A timer this teammate does not know is a mistake in its setup, so a person should see it.
      run.outcome(thread, "handed_to_human", `A timer called "${fired.name}" fired, and this teammate has no work for it.`);
    }
  }
  return rest;
}
