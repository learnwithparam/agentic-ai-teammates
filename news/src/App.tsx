import { AnimatePresence, motion, type PanInfo, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { type Card, dayLabel, type Edition, loadDays, loadEdition, NoEdition, step } from "./edition";

// One story per screen. Swipe, use the arrow keys or the buttons to move; the bar at the top
// shows how far through the day you are. The page after the last story lists earlier days.

type Loaded = { status: "loading" } | { status: "ready"; edition: Edition; days: string[] } | { status: "empty" } | { status: "failed"; message: string };

// A swipe further than this, or faster than SWIPE_SPEED, moves to the next story.
const SWIPE_DISTANCE = 80;
const SWIPE_SPEED = 400;

function dayFromAddress(): string | null {
  const day = new URLSearchParams(window.location.search).get("day");
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  const load = useCallback(() => {
    setLoaded({ status: "loading" });
    // The list of days only fills the archive, so the stories still show when it fails to load.
    Promise.all([loadEdition(dayFromAddress()), loadDays().catch(() => [])])
      .then(([edition, days]) => setLoaded({ status: "ready", edition, days }))
      .catch((error) => setLoaded(error instanceof NoEdition ? { status: "empty" } : { status: "failed", message: error instanceof Error ? error.message : String(error) }));
  }, []);

  useEffect(load, [load]);

  if (loaded.status === "ready") return <Reader edition={loaded.edition} days={loaded.days} />;
  return (
    <main className="mx-auto flex h-full max-w-xl flex-col justify-center gap-4 px-6">
      <Masthead />
      {loaded.status === "loading" && <p className="text-lg text-muted">Getting the news.</p>}
      {loaded.status === "empty" && <p className="text-lg">No edition yet. The first one comes out at seven on a working morning.</p>}
      {loaded.status === "failed" && (
        <>
          <p className="text-lg">{loaded.message} Check your connection, then try again.</p>
          <button type="button" onClick={load} className="self-start rounded-full bg-berry px-5 py-2.5 font-semibold text-sheet">
            Try again
          </button>
        </>
      )}
    </main>
  );
}

function Masthead({ day }: { day?: string }) {
  return (
    <p className="text-[15px] text-muted">
      <a href="./" className="font-bold text-ink">
        Bramble morning news
      </a>
      {day && <span>, {dayLabel(day)}</span>}
    </p>
  );
}

function Reader({ edition, days }: { edition: Edition; days: string[] }) {
  const total = edition.cards.length;
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const reduceMotion = useReducedMotion();

  const move = useCallback(
    (by: number) => {
      setDirection(by);
      setIndex((current) => step(current, by, total));
    },
    [total],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowRight") move(1);
      if (event.key === "ArrowLeft") move(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  function onDragEnd(_event: unknown, info: PanInfo) {
    if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_SPEED) move(1);
    else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_SPEED) move(-1);
  }

  const slide = reduceMotion ? 0 : 60;
  const atEnd = index === total;

  return (
    <main className="mx-auto flex h-full max-w-xl flex-col px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <Progress total={total} index={index} onPick={(to) => move(to - index)} />
      <div className="mt-4">
        <Masthead day={edition.day} />
      </div>
      <div className="relative mt-5 flex-1 overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <motion.article
            key={index}
            custom={direction}
            initial={{ opacity: 0, x: direction * slide }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction * -slide }}
            transition={{ duration: reduceMotion ? 0.15 : 0.32, ease: [0.2, 0.7, 0.2, 1] }}
            drag={reduceMotion ? false : "x"}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.35}
            onDragEnd={onDragEnd}
            className="absolute inset-0 touch-pan-y overflow-y-auto"
            aria-live="polite"
          >
            {atEnd ? <Closing day={edition.day} days={days} onRestart={() => move(-total)} /> : <Story card={edition.cards[index]} />}
          </motion.article>
        </AnimatePresence>
      </div>
      <nav className="mt-4 grid grid-cols-3 items-center" aria-label="Stories">
        <button type="button" onClick={() => move(-1)} disabled={index === 0} className="justify-self-start rounded-full px-4 py-2.5 font-semibold text-berry disabled:invisible">
          Previous
        </button>
        <span className="text-center text-sm text-muted tabular-nums">{atEnd ? "The end" : `${index + 1} of ${total}`}</span>
        <button type="button" onClick={() => move(1)} disabled={atEnd} className="justify-self-end rounded-full bg-berry px-5 py-2.5 font-semibold text-sheet disabled:invisible">
          Next
        </button>
      </nav>
    </main>
  );
}

// One segment per story, filled in riso yellow up to the one you are reading.
function Progress({ total, index, onPick }: { total: number; index: number; onPick: (to: number) => void }) {
  return (
    <div className="flex gap-1.5" role="group" aria-label="Your place in today's news">
      {Array.from({ length: total }, (_, at) => (
        <button
          key={at}
          type="button"
          onClick={() => onPick(at)}
          aria-label={`Story ${at + 1} of ${total}`}
          aria-current={at === index ? "step" : undefined}
          className="h-6 flex-1 py-2"
        >
          <span className={`block h-full rounded-full transition-colors ${at <= index ? "bg-riso" : "bg-ink/12"} ${at === index ? "ring-1 ring-ink/40" : ""}`} />
        </button>
      ))}
    </div>
  );
}

function Story({ card }: { card: Card }) {
  return (
    <div className="flex min-h-full flex-col gap-6 pb-2">
      <p className="self-start rounded-full border border-leaf/40 px-3 py-1 text-sm font-medium text-leaf">{card.topic}</p>
      <h1 className="headline text-[clamp(2.4rem,9vw,3.6rem)] text-berry">{card.headline}</h1>
      <ul className="flex max-w-[62ch] flex-col gap-3 text-[1.075rem] leading-relaxed">
        {card.bullets.map((bullet) => (
          <li key={bullet} className="flex gap-3">
            <span aria-hidden className="mt-[0.6em] size-2 shrink-0 rounded-[2px] bg-berry" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
      <section className="mt-auto rounded-2xl bg-leaf px-5 py-4 text-sheet">
        <h2 className="text-sm font-semibold text-sheet/80">Why it matters to us</h2>
        <p className="mt-1 text-[1.05rem] leading-snug">{card.whyItMatters}</p>
      </section>
      <a href={card.url} target="_blank" rel="noopener noreferrer" className="self-start font-semibold text-berry underline decoration-2 underline-offset-4">
        Read it on {card.source}
      </a>
    </div>
  );
}

function Closing({ day, days, onRestart }: { day: string; days: string[]; onRestart: () => void }) {
  const earlier = days.filter((other) => other !== day).slice(0, 14);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="headline text-[clamp(2.4rem,9vw,3.6rem)] text-berry">That's the news for {dayLabel(day).split(" ")[0]}.</h1>
      <button type="button" onClick={onRestart} className="self-start rounded-full border-2 border-berry px-5 py-2 font-semibold text-berry">
        Read it again
      </button>
      {earlier.length > 0 && (
        <section>
          <h2 className="font-semibold">Earlier days</h2>
          <ul className="mt-2 divide-y divide-ink/10">
            {earlier.map((other) => (
              <li key={other}>
                <a href={`?day=${other}`} className="block py-3 text-lg hover:text-berry">
                  {dayLabel(other)}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
