import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { get, RunDetail, type Step } from "./api";
import { Tone } from "./Tone";
import { duration, eventLabel, formatSpend, sourceLabel, STOP_REASONS, when } from "./words";

// One run, step by step, in the words the teammate wrote while it worked. Which model ran a step
// stays in the trace; the step says only "Quick check" or "Deeper look".

const KINDS: Record<string, string> = {
  tool: "Used a tool",
  model: "Thought",
  route: "Chose how",
  check: "Checked",
  note: "Noted",
};

// A step's detail as short "name: value" lines. Nested objects stay in the trace.
function detailLines(detail: Step["detail"]): [string, string][] {
  const lines: [string, string][] = [];
  for (const [name, value] of Object.entries(detail)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") lines.push([name, String(value)]);
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) lines.push([name, value.join(", ")]);
  }
  return lines.slice(0, 6);
}

function StepRow({ step }: { step: Step }) {
  const lines = detailLines(step.detail);
  return (
    <li className="relative border-l-2 border-border pb-4 pl-4 last:pb-0">
      <span aria-hidden className="absolute top-1.5 -left-[5px] size-2 rounded-full bg-foreground" />
      <p className="text-xs text-muted-foreground">
        {KINDS[step.kind] ?? step.kind}, {when(step.at)}
      </p>
      <p className="text-sm font-medium">{step.title}</p>
      {lines.length > 0 && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
          {lines.map(([name, value]) => (
            <div key={name} className="contents">
              <dt>{name}</dt>
              <dd className="min-w-0 truncate" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function RunSheet({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    setDetail(null);
    setProblem(null);
    get(`/api/runs/${runId}`, RunDetail)
      .then(setDetail)
      .catch((error) => setProblem(error instanceof Error ? error.message : String(error)));
  }, [runId]);

  const run = detail?.run;
  const stop = run?.stop_reason ? STOP_REASONS[run.stop_reason] : null;

  return (
    <Sheet open={runId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle className="font-display text-lg">{run ? (run.summary ?? "Working") : "A run"}</SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-2">
              {run && (stop ? <Tone tone={stop.tone}>{stop.label}</Tone> : <Tone tone="busy">Working</Tone>)}
              {run && (
                <span>
                  Started {when(run.started_at)}, took {duration(run.started_at, run.finished_at)}, cost {formatSpend(run.cost_usd)}
                </span>
              )}
            </div>
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 p-4">
          {problem && <p className="text-sm text-fail">{problem}</p>}
          {!detail && !problem && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}
          {detail && detail.events.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">What woke it</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {detail.events.map((event) => (
                  <li key={event.id} className="flex justify-between gap-3">
                    <span>
                      {eventLabel(event)} from {sourceLabel(event.source)}
                    </span>
                    <span className="text-muted-foreground tabular-nums">{when(event.received_at)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail && (
            <section>
              <h3 className="mb-3 text-sm font-semibold">Steps</h3>
              {detail.steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">This run took no steps.</p>
              ) : (
                <ol>
                  {detail.steps.map((step) => (
                    <StepRow key={step.id} step={step} />
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
