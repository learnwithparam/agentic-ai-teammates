import type { Board, SignedIn } from "./api";
import { WaitingCards } from "./Board";
import { needsYou, teammateOf } from "./needs-you";
import type { Route } from "./route";
import { Tone } from "./Tone";
import { STOP_REASONS, when } from "./words";

// The first screen: every card waiting for a person, from every teammate, grouped by teammate with
// the oldest card first. Under it, one line per run today, so a person sees the day at a glance.

function today(iso: string) {
  return new Date(iso).toDateString() === new Date().toDateString();
}

export function Home({ board, me, onOpenRun, refresh, goTo }: { board: Board; me: SignedIn; onOpenRun: (id: string) => void; refresh: () => void; goTo: (route: Route) => void }) {
  const waiting = needsYou(board);
  const groups = board.teammates.map((mate) => ({ mate, items: waiting.filter((item) => teammateOf(item) === mate.id) })).filter((group) => group.items.length > 0);
  const ran = board.runs.filter((run) => today(run.started_at));
  const nameOf = (id: string) => board.teammates.find((mate) => mate.id === id)?.name ?? id;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4 lg:p-6">
      <section aria-labelledby="needs-you" className="flex flex-col gap-4">
        <h2 id="needs-you" className="sr-only">
          Needs you
        </h2>
        {groups.length === 0 && <p className="rounded-xl bg-muted/60 px-4 py-10 text-center text-sm text-muted-foreground">Nothing needs you. A teammate asks here when a check fails.</p>}
        {groups.map(({ mate, items }) => (
          <section key={mate.id} aria-label={mate.name} className="flex flex-col gap-2 rounded-xl bg-accent/45 p-2">
            <header className="flex items-baseline justify-between px-2 pt-1">
              <a
                href={`/teammates/${mate.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  goTo({ page: "teammate", id: mate.id, tab: "work" });
                }}
                className="font-display text-base font-semibold underline-offset-4 hover:underline"
              >
                {mate.name}
              </a>
              <span className="text-sm text-muted-foreground tabular-nums">{items.length}</span>
            </header>
            <WaitingCards items={items} me={me} onDone={refresh} onOpenRun={onOpenRun} />
          </section>
        ))}
      </section>

      <section aria-labelledby="today" className="rounded-xl border bg-card p-4">
        <h2 id="today" className="font-display text-base font-semibold">
          Today
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">Every run a teammate started today.</p>
        {ran.length === 0 ? (
          <p className="text-sm text-muted-foreground">No teammate has run today.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {ran.map((run) => {
              const stop = run.stop_reason ? STOP_REASONS[run.stop_reason] : null;
              return (
                <li key={run.id}>
                  <button type="button" onClick={() => onOpenRun(run.id)} className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-left text-sm hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex-nowrap">
                    <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">{when(run.started_at)}</span>
                    <span className="w-40 shrink-0 truncate text-muted-foreground">{nameOf(run.teammate)}</span>
                    {stop ? <Tone tone={stop.tone}>{stop.label}</Tone> : <Tone tone="busy">Working</Tone>}
                    <span className="min-w-0 basis-full truncate sm:basis-auto">{run.summary ?? "Reading what came in."}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
