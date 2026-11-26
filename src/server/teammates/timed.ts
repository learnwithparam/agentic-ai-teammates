import { z } from "zod";
import type { InboxEvent } from "../inbox";
import { COMPANIES } from "../people";
import type { Run } from "../run";
import { FOLLOW_UP_PREFIX } from "../tools/team";

// What every teammate does when one of its timers fires. A reminder and a digest are the same for
// each teammate, so the teammate's own graph only sees the events that are its real work.

const Queued = z.object({ queued: z.number().int() });
const Fired = z.object({ name: z.string(), firedFor: z.iso.datetime(), approvalId: z.uuid().optional() });

// The day a firing belongs to, on the company's clock, as YYYY-MM-DD.
export function companyDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// The time as someone at the company reads it, weekday first, such as "Thursday, 26 November
// 2026 at 03:36 (Europe/Amsterdam)". Given only an ISO time, a model asked to look again "on
// Friday" set the follow-up for Saturday.
export function companyTime(at: Date, timezone: string): string {
  const text = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(at);
  return `${text} (${timezone})`;
}

// The next seven days on the company's clock, each named, such as "Friday, 27 November 2026
// (2026-11-27)". Given today's weekday alone, the quick model still counted Friday as the 28th.
// With the days written out, "on Friday" is a lookup, not a sum.
export function comingDays(at: Date, timezone: string): string[] {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  // Counted from noon on today's date, so a clock change near midnight never skips or repeats a day.
  const [year, month, date] = companyDay(at, timezone).split("-").map(Number);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(Date.UTC(year, month - 1, date + index + 1, 12));
    return `${name.format(day)} (${companyDay(day, timezone)})`;
  });
}

// Handles the shared timer events in a batch: reminders and the digest. The teammate's own
// schedules and its follow-ups pass on with the rest.
export async function handleTimers(run: Run, events: InboxEvent[], options: { own: ReadonlySet<string>; digest: boolean }): Promise<InboxEvent[]> {
  const rest: InboxEvent[] = [];
  for (const event of events) {
    const fired = event.type === "timer.fired" ? Fired.parse(event.payload) : null;
    if (!fired || options.own.has(fired.name) || fired.name.startsWith(FOLLOW_UP_PREFIX)) {
      rest.push(event);
      continue;
    }
    const thread = `timer:${fired.name}`;
    if (fired.name.startsWith("remind:") && fired.approvalId) {
      const result = await run.tool(thread, "team.remind", { approvalId: fired.approvalId });
      if (result.status !== "done") run.outcome(thread, "handed_to_human", result.status === "denied" ? result.reason : "The reminder asked for an approval.");
      else if (Queued.parse(result.result).queued === 0) run.outcome(thread, "nothing_to_send", "The approval was decided before the reminder.");
      else run.outcome(thread, "sent", "Reminded the people who decide.");
    } else if (fired.name === "digest" && options.digest) {
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
