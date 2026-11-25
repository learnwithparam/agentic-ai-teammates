import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ApiError, type OutboxMessage, post } from "./api";
import { targetLabel, when } from "./words";

// A message a quiet teammate wrote and did not send. A person reads it here, then sends it
// or throws it away. Sending hands it to the dispatcher, which paces and retries it.

const Mail = z.object({ to: z.string(), subject: z.string().optional(), text: z.string() });
const NewsCard = z.object({ headline: z.string(), source: z.string() });
const News = z.object({ day: z.string(), cards: z.array(NewsCard) });
const Tidy = z.object({ topic: z.string(), lines: z.array(z.string()), why: z.string() });

function Preview({ message }: { message: OutboxMessage }) {
  const mail = message.target === "lmail.send" ? Mail.safeParse(message.payload) : null;
  if (mail?.success) {
    return (
      <div className="rounded-md bg-muted px-3 py-2 text-sm">
        <p className="text-xs text-muted-foreground">To {mail.data.to}</p>
        {mail.data.subject && <p className="font-medium">{mail.data.subject}</p>}
        <p className="mt-1 line-clamp-4 whitespace-pre-line">{mail.data.text}</p>
      </div>
    );
  }
  const news = message.target === "news.publish" ? News.safeParse(message.payload) : null;
  if (news?.success) {
    return (
      <ol className="flex list-decimal flex-col gap-1 rounded-md bg-muted py-2 pr-3 pl-8 text-sm">
        {news.data.cards.map((card) => (
          <li key={card.headline}>
            {card.headline} <span className="text-muted-foreground">({card.source})</span>
          </li>
        ))}
      </ol>
    );
  }
  const tidy = message.target === "memory.tidy" ? Tidy.safeParse(message.payload) : null;
  if (tidy?.success) {
    return (
      <div className="rounded-md bg-muted px-3 py-2 text-sm">
        <p className="text-xs text-muted-foreground">{tidy.data.why}</p>
        <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
          {tidy.data.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}

export function OutboxCard({ message, canRelease, onDone }: { message: OutboxMessage; canRelease: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function release(send: boolean) {
    setBusy(true);
    setProblem(null);
    try {
      await post(`/api/outbox/${message.id}/release`, { send });
      onDone();
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "That did not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <header>
        <p className="text-xs text-muted-foreground">
          {targetLabel(message.target)}, written {when(message.createdAt)}
        </p>
        <h3 className="font-display text-base leading-snug font-semibold">{message.title}</h3>
      </header>
      <Preview message={message} />
      {!canRelease && <p className="text-sm text-muted-foreground">An admin sends this or throws it away.</p>}
      <div className="flex flex-wrap gap-2" hidden={!canRelease}>
        <Button size="sm" onClick={() => release(true)} disabled={busy}>
          Send it
        </Button>
        <Button size="sm" variant="outline" onClick={() => release(false)} disabled={busy}>
          Throw it away
        </Button>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-fail">
          {problem}
        </p>
      )}
    </article>
  );
}
