import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, Conversation, get, type Line, post, type Teammate } from "./api";

// A person talks to one teammate. A message goes into the teammate's inbox like any other event,
// so the answer comes from a run, with the teammate's tools and rules. The page asks for the
// thread again until the answer with the same message id is there.

const ASK_EVERY_MS = 2000;
const GIVE_UP_MS = 120_000;

function toMessage(line: Line): ThreadMessageLike {
  return { id: `${line.messageId}-${line.role}`, role: line.role === "person" ? "user" : "assistant", content: line.text, createdAt: new Date(line.at) };
}

function PersonMessage() {
  return (
    <MessagePrimitive.Root className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function TeammateMessage() {
  return (
    <MessagePrimitive.Root className="max-w-[92%] text-sm leading-relaxed">
      <MessagePrimitive.Parts components={{ Text: () => <MarkdownTextPrimitive className="flex flex-col gap-2 [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5" /> }} />
    </MessagePrimitive.Root>
  );
}

function Waiting() {
  return (
    <AuiIf condition={(state) => state.thread.isRunning}>
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <span className="size-2 animate-pulse rounded-full bg-foreground" />
        Working on it. Answers come from a run, so they take a few seconds.
      </p>
    </AuiIf>
  );
}

export function Thread({ teammate }: { teammate: Teammate }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const since = useRef(0);

  const load = useCallback(async () => {
    const { lines: fresh } = await get(`/api/teammates/${teammate.id}/conversation`, Conversation);
    setLines(fresh);
    return fresh;
  }, [teammate.id]);

  useEffect(() => {
    setLines([]);
    setWaitingFor(null);
    setProblem(null);
    load().catch((error) => setProblem(error instanceof Error ? error.message : String(error)));
  }, [load]);

  // While a message waits for its answer, ask again every two seconds.
  useEffect(() => {
    if (!waitingFor) return;
    const timer = window.setInterval(async () => {
      const fresh = await load().catch(() => null);
      const answered = fresh?.some((line) => line.messageId === waitingFor && line.role === "teammate");
      if (answered) setWaitingFor(null);
      else if (Date.now() - since.current > GIVE_UP_MS) {
        setWaitingFor(null);
        setProblem(`${teammate.name} has not answered yet. The answer shows here when its run finishes.`);
      }
    }, ASK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [waitingFor, load, teammate.name]);

  const runtime = useExternalStoreRuntime<Line>({
    messages: lines,
    convertMessage: toMessage,
    isRunning: waitingFor !== null,
    onNew: async (message) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) return;
      const messageId = crypto.randomUUID();
      setProblem(null);
      setLines((current) => [...current, { messageId, role: "person", author: "You", text, runId: null, at: new Date().toISOString() }]);
      try {
        await post(`/api/teammates/${teammate.id}/messages`, { messageId, text });
        since.current = Date.now();
        setWaitingFor(messageId);
      } catch (error) {
        setLines((current) => current.filter((line) => line.messageId !== messageId));
        setProblem(error instanceof ApiError ? error.message : "The message did not send. Try again.");
      }
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <AuiIf condition={(state) => state.thread.isEmpty}>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">Ask {teammate.name} what it is doing, or why it stopped. It answers from its runs and its tools.</p>
              <div className="flex flex-col items-start gap-2">
                {teammate.asks.map((prompt) => (
                  <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send asChild>
                    <button type="button" className="rounded-full border px-3 py-1.5 text-left text-sm hover:bg-muted">
                      {prompt}
                    </button>
                  </ThreadPrimitive.Suggestion>
                ))}
              </div>
            </div>
          </AuiIf>
          <ThreadPrimitive.Messages components={{ UserMessage: PersonMessage, AssistantMessage: TeammateMessage }} />
          <Waiting />
          {problem && (
            <p role="alert" className="text-sm text-fail">
              {problem}
            </p>
          )}
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="m-3 flex items-end gap-2 rounded-xl border bg-card p-2 focus-within:ring-2 focus-within:ring-ring/40">
          <ComposerPrimitive.Input
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
            placeholder={`Message ${teammate.name}`}
            maxLength={2000}
            aria-label={`Message ${teammate.name}`}
          />
          <ComposerPrimitive.Send asChild>
            <Button size="icon" aria-label="Send">
              <ArrowUp />
            </Button>
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
