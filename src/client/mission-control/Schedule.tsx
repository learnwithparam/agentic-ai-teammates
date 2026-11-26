import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { problemText } from "@/lib/http";
import { get, post, type SignedIn, type Teammate, TeammateTimers } from "./api";
import { Section } from "./Section";
import { Tone } from "./Tone";
import { onClock, STOP_REASONS, when } from "./words";

// What a teammate will do next. Its schedules repeat and stop only when it is paused. A follow-up
// fires once, for the person who asked; that person or an admin can cancel it before it fires.

type Timers = TeammateTimers;

function RecentRuns({ runs, onOpenRun }: { runs: Timers["schedules"][number]["runs"]; onOpenRun: (id: string) => void }) {
  if (runs.length === 0) return <p className="text-xs text-muted-foreground">It has not run on this schedule in the last 30 days.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {runs.map((run) => {
        const stop = run.stop_reason ? STOP_REASONS[run.stop_reason] : null;
        return (
          <li key={run.id}>
            <button type="button" onClick={() => onOpenRun(run.id)} className="flex w-full items-baseline gap-3 rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <span className="w-28 shrink-0 text-xs text-muted-foreground tabular-nums">{when(run.started_at)}</span>
              {stop ? <Tone tone={stop.tone}>{stop.label}</Tone> : <Tone tone="busy">Working</Tone>}
              <span className="min-w-0 truncate">{run.summary ?? "Reading what came in."}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

type RowProps = { item: Timers["followUps"][number]; timezone: string; me: SignedIn; teammate: string; onCancelled: () => void };

function FollowUpRow({ item, timezone, me, teammate, onCancelled }: RowProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mayCancel = item.askedBy === me.email || me.roles.includes("admin");

  async function cancel() {
    setBusy(true);
    setProblem(null);
    try {
      await post(`/api/teammates/${teammate}/timers/${encodeURIComponent(item.name)}`, {}, "DELETE");
      onCancelled();
    } catch (error) {
      setProblem(problemText(error, "The follow-up was not cancelled. Try again."));
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="font-medium">{item.about}</p>
        {item.reason && <p className="text-sm text-muted-foreground">{item.reason}</p>}
        <p className="text-xs text-muted-foreground tabular-nums">
          {onClock(item.at, timezone)}. Asked by {item.askedBy === me.email ? "you" : (item.askedBy ?? "the teammate")}, {when(item.setAt)}.
        </p>
        {problem && <p className="mt-1 text-sm text-fail">{problem}</p>}
      </div>
      {mayCancel && (
        <Button size="sm" variant="outline" onClick={cancel} disabled={busy}>
          Cancel follow-up
        </Button>
      )}
    </li>
  );
}

export function Schedule({ teammate, me, onOpenRun }: { teammate: Teammate; me: SignedIn; onOpenRun: (id: string) => void }) {
  const [timers, setTimers] = useState<Timers | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(() => {
    get(`/api/teammates/${teammate.id}/timers`, TeammateTimers)
      .then(setTimers)
      .catch((error) => setProblem(problemText(error)));
  }, [teammate.id]);
  useEffect(load, [load]);

  if (problem) return <p className="p-4 text-sm text-fail">{problem}</p>;
  if (!timers) return <p className="p-4 text-sm text-muted-foreground">Loading what it does next.</p>;

  return (
    <div className="flex flex-col gap-5 p-4">
      <Section title="Schedules" hint={teammate.paused ? "It is paused, so none of these runs until an admin turns it back on." : `Work it starts on its own. Times are on the company's clock, ${timers.timezone.replace("_", " ")}.`}>
        {timers.schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">It has no schedule. It works when something arrives.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {timers.schedules.map((schedule) => (
              <li key={schedule.name} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="font-medium">
                    {schedule.label} <span className="font-normal text-muted-foreground">{schedule.when}</span>
                  </p>
                  <p className="text-sm text-muted-foreground tabular-nums">Next {onClock(schedule.nextAt, timers.timezone)}</p>
                </div>
                <RecentRuns runs={schedule.runs} onOpenRun={onOpenRun} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Follow-ups" hint="Checks someone asked it to make later. Each one fires once.">
        {timers.followUps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No follow-up waits. Ask it in the conversation, such as "On Friday, check whether Lumen replied."</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {timers.followUps.map((item) => (
              <FollowUpRow key={item.name} item={item} timezone={timers.timezone} me={me} teammate={teammate.id} onCancelled={load} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
