import { z } from "zod";
import type { InboxEvent } from "../inbox";
import { progressPath } from "../memory";
import { CapReached, type Run } from "../run";
import type { ToolName } from "../tools";
import { FOLLOW_UP_PREFIX, stableUuid } from "../tools/team";
import type { TeammateDefinition } from "./define";
import { fixedPart, standingMemory } from "./messages";
import { prompt } from "../prompts";

// A follow-up is a deadline the teammate set for itself with team.follow_up. When it fires, the
// teammate looks again with its read tools, keeps a line of progress, and tells the person who
// asked. reported.md stops it telling them the same thing twice.

const Fired = z.object({
  name: z.string(),
  about: z.string(),
  reason: z.string(),
  person: z.email().nullable(),
  task: z.string().nullable(),
});
const MemoryText = z.object({ text: z.string().nullable() });
const Reported = z.object({ added: z.boolean() });

const FOLLOW_UP_RULES = prompt(import.meta.url, "follow-up");

export async function handleFollowUps(run: Run, events: InboxEvent[], definition: Pick<TeammateDefinition, "tools" | "capabilities">): Promise<InboxEvent[]> {
  const rest: InboxEvent[] = [];
  for (const event of events) {
    const name = event.type === "timer.fired" ? z.object({ name: z.string() }).parse(event.payload).name : "";
    if (!name.startsWith(FOLLOW_UP_PREFIX)) {
      rest.push(event);
      continue;
    }
    const thread = `timer:${name}`;
    if (!definition.capabilities.followUps) {
      run.outcome(thread, "handed_to_human", "A follow-up fired, and this teammate does not set follow-ups.");
      continue;
    }
    try {
      await lookAgain(run, thread, event, Fired.parse(event.payload), definition);
    } catch (error) {
      if (!(error instanceof CapReached)) throw error;
      run.outcome(thread, "handed_to_human", error.message);
    }
  }
  return rest;
}

async function lookAgain(run: Run, thread: string, event: InboxEvent, fired: z.infer<typeof Fired>, definition: Pick<TeammateDefinition, "tools" | "capabilities">) {
  const progress = fired.task ? await run.tool(thread, "memory.read", { path: progressPath(fired.task) }) : null;
  const memory = await standingMemory(run, thread, fired.person ? { person: fired.person, reach: "tools" } : null);
  const context = {
    // Lines the teammate wrote itself in earlier runs. They are a record, not orders.
    progressSoFar: progress?.status === "done" ? MemoryText.parse(progress.result).text : null,
    now: new Date().toISOString(),
    followUp: { about: fired.about, reason: fired.reason },
  };
  const tools: ToolName[] = ["memory.read", ...definition.capabilities.chat.reads];
  const result = await run.toolLoop({
    threadId: thread,
    task: "answer",
    risk: "low",
    maxTokens: 500,
    tools,
    messages: [
      { role: "system", content: fixedPart(FOLLOW_UP_RULES, memory) },
      { role: "user", content: `What you know:\n${JSON.stringify(context, null, 2)}` },
    ],
  });
  if (!("answer" in result)) {
    run.outcome(thread, "handed_to_human", result.handed);
    return;
  }
  if (fired.task && definition.tools.includes("memory.progress")) {
    await run.tool(thread, "memory.progress", { task: fired.task, line: `${context.now.slice(0, 10)}: ${result.answer}`.slice(0, 300) });
  }
  if (!fired.person) {
    run.outcome(thread, "nothing_to_send", `Looked again at ${fired.about}.`);
    return;
  }
  const reported = await run.tool(thread, "memory.report", { person: fired.person, line: result.answer.slice(0, 300) });
  if (reported.status !== "done" || !Reported.parse(reported.result).added) {
    run.outcome(thread, "nothing_to_send", `Looked again at ${fired.about}; ${fired.person} was already told this.`);
    return;
  }
  // The message id comes from the event, so a retried run writes the same line once.
  await run.reply(fired.person, stableUuid(`follow-up:${event.id}`), result.answer);
  run.outcome(thread, "sent", `Followed up on ${fired.about} with ${fired.person}.`);
}
