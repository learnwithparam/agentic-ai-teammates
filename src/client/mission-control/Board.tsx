import type { ReactNode } from "react";
import type { Board as BoardData, InboxEvent, SignedIn, Run, Teammate } from "./api";
import { ApprovalCard } from "./ApprovalCard";
import { needsYou } from "./needs-you";
import { OutboxCard } from "./OutboxCard";
import { Tone } from "./Tone";
import { duration, eventLabel, formatSpend, sourceLabel, STOP_REASONS, when } from "./words";

// One teammate's work in four columns, left to right, the way work moves: it arrives, the teammate
// works on it, it waits for a person or it is done. "Needs you" is the one column a person acts
// in, so it is marked, and on a phone it comes first. Its oldest card is at the top.

const DONE_SHOWN = 25;

function Column({ title, count, marked, children, empty }: { title: string; count: number; marked?: boolean; children: ReactNode; empty: string }) {
  return (
    <section aria-label={title} className="flex w-[min(86vw,22rem)] shrink-0 snap-start flex-col rounded-xl bg-muted/60 data-[marked=true]:order-first data-[marked=true]:bg-accent/45 xl:w-auto xl:data-[marked=true]:order-none xl:min-w-0" data-marked={marked}>
      <header className="flex items-baseline justify-between px-4 pt-3 pb-2">
        <h2 className="font-display text-base font-semibold">{title}</h2>
        <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">{count === 0 ? <p className="px-2 py-6 text-center text-sm text-muted-foreground">{empty}</p> : children}</div>
    </section>
  );
}

function nameOf(teammates: Teammate[], id: string) {
  return teammates.find((mate) => mate.id === id)?.name ?? id;
}

function EventCard({ event, teammates }: { event: InboxEvent; teammates: Teammate[] }) {
  const dead = event.status === "dead";
  return (
    <article className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="text-sm font-medium">{eventLabel(event)}</p>
        {dead ? <Tone tone="fail">Gave up</Tone> : <span className="text-xs text-muted-foreground tabular-nums">{when(event.received_at)}</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        From {sourceLabel(event.source)} for {nameOf(teammates, event.teammate)}
        {event.attempts > 1 ? `, tried ${event.attempts} times` : ""}
      </p>
      {event.error && <p className="mt-1 text-xs text-fail">{event.error}</p>}
    </article>
  );
}

function RunCard({ run, teammates, onOpen }: { run: Run; teammates: Teammate[]; onOpen: () => void }) {
  const stop = run.stop_reason ? STOP_REASONS[run.stop_reason] : null;
  return (
    <button type="button" onClick={onOpen} className="w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="text-xs text-muted-foreground">{nameOf(teammates, run.teammate)}</p>
        {stop ? <Tone tone={stop.tone}>{stop.label}</Tone> : <Tone tone="busy">Working</Tone>}
      </div>
      <p className="mt-1 line-clamp-3 text-sm">{run.summary ?? "Reading what came in."}</p>
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        {when(run.started_at)}, {duration(run.started_at, run.finished_at)}
        {run.cost_usd > 0 ? `, ${formatSpend(run.cost_usd)}` : ""}
      </p>
    </button>
  );
}

export function Board({ board, me, teammate, onOpenRun, refresh }: { board: BoardData; me: SignedIn; teammate: string; onOpenRun: (id: string) => void; refresh: () => void }) {
  const mine = <T extends { teammate: string }>(rows: T[]) => rows.filter((row) => row.teammate === teammate);
  const arrived = mine(board.inbox).filter((event) => event.status === "queued" || event.status === "dead");
  const working = mine(board.runs).filter((run) => run.status === "running");
  const waiting = needsYou(board, teammate);
  const done = mine(board.runs)
    .filter((run) => run.status === "finished")
    .slice(0, DONE_SHOWN);

  return (
    <div className="flex h-full snap-x snap-mandatory gap-3 overflow-x-auto p-3 xl:grid xl:grid-cols-[1fr_1fr_1.35fr_1fr] xl:overflow-x-visible">
      <Column title="Inbox" count={arrived.length} empty="Nothing waiting. New mail and files land here.">
        {arrived.map((event) => (
          <EventCard key={event.id} event={event} teammates={board.teammates} />
        ))}
      </Column>
      <Column title="Working" count={working.length} empty="It is not working right now.">
        {working.map((run) => (
          <RunCard key={run.id} run={run} teammates={board.teammates} onOpen={() => onOpenRun(run.id)} />
        ))}
      </Column>
      <Column title="Needs you" count={waiting.length} marked empty="Nothing needs you. It asks here when a check fails.">
        <WaitingCards items={waiting} me={me} onDone={refresh} onOpenRun={onOpenRun} />
      </Column>
      <Column title="Done" count={done.length} empty="Finished runs show here.">
        {done.map((run) => (
          <RunCard key={run.id} run={run} teammates={board.teammates} onOpen={() => onOpenRun(run.id)} />
        ))}
      </Column>
    </div>
  );
}

// The cards a person acts on, in the order given. Home and a teammate's Work tab both use it.
export function WaitingCards({ items, me, onDone, onOpenRun }: { items: ReturnType<typeof needsYou>; me: SignedIn; onDone: () => void; onOpenRun: (id: string) => void }) {
  const admin = me.roles.includes("admin");
  return items.map((item) =>
    item.kind === "approval" ? (
      <ApprovalCard key={item.approval.id} approval={item.approval} me={me} onDecided={onDone} onOpenRun={onOpenRun} />
    ) : (
      <OutboxCard key={item.message.id} message={item.message} canRelease={admin} onDone={onDone} />
    ),
  );
}

export { RunCard };
