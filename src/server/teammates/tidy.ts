import { z } from "zod";
import type { InboxEvent } from "../inbox";
import { INDEX, NOTE_LINES, NOTE_PATH } from "../memory";
import { modelSchema } from "../model-schema";
import { prompt } from "../prompts";
import { CapReached, type Run } from "../run";
import type { TeammateDefinition } from "./define";

// The weekly tidy, the article's "dreaming". Once a week the teammate reads each note it keeps and
// proposes a shorter one. A proposal is a draft in the outbox: a note changes only after a person
// reads the new lines and sends them, so memory never rewrites itself unseen.

const TIDY_RULES = prompt(import.meta.url, "tidy");
// One tidy reads a few notes, so its cost stays small however many notes there are.
export const NOTES_PER_TIDY = 5;

const MemoryText = z.object({ text: z.string().nullable() });
const Tidied = modelSchema(
  "tidy",
  z.object({
    changed: z.boolean(),
    lines: z.array(z.string().min(1).max(300)).max(NOTE_LINES),
    why: z.string().min(1).max(300),
  }),
);

const linesOf = (text: string | null) => (text ?? "").split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));

export async function handleTidy(run: Run, events: InboxEvent[], definition: Pick<TeammateDefinition, "capabilities">): Promise<InboxEvent[]> {
  const rest: InboxEvent[] = [];
  for (const event of events) {
    const name = event.type === "timer.fired" ? z.object({ name: z.string() }).parse(event.payload).name : "";
    if (name !== "tidy" || !definition.capabilities.tidy) {
      rest.push(event);
      continue;
    }
    try {
      await tidy(run, "timer:tidy");
    } catch (error) {
      if (!(error instanceof CapReached)) throw error;
      run.outcome("timer:tidy", "handed_to_human", error.message);
    }
  }
  return rest;
}

async function read(run: Run, thread: string, path: string): Promise<string | null> {
  const result = await run.tool(thread, "memory.read", { path });
  return result.status === "done" ? MemoryText.parse(result.result).text : null;
}

async function tidy(run: Run, thread: string) {
  const notes = linesOf(await read(run, thread, INDEX)).filter((path) => NOTE_PATH.test(path));
  let proposed = 0;
  for (const path of notes.slice(0, NOTES_PER_TIDY)) {
    const lines = linesOf(await read(run, thread, path));
    // A note of one line has nothing to merge.
    if (lines.length < 2) continue;
    const messages = [
      { role: "system" as const, content: TIDY_RULES },
      { role: "user" as const, content: `<note path="${path}">\n${lines.map((line) => `- ${line}`).join("\n")}\n</note>` },
    ];
    const answer = await run.structured({ task: "tidy", risk: "low", messages, maxTokens: 1500 }, Tidied.format, Tidied.parse);
    if ("handed" in answer) {
      run.outcome(thread, "handed_to_human", answer.handed);
      return;
    }
    const same = answer.value.lines.length === lines.length && answer.value.lines.every((line, index) => line === lines[index]);
    if (!answer.value.changed || same) continue;
    const topic = path.slice("notes/".length, -".md".length);
    const result = await run.tool(thread, "memory.propose_tidy", { topic, lines: answer.value.lines, why: answer.value.why });
    if (result.status === "done") proposed += 1;
  }
  if (proposed === 0) run.outcome(thread, "nothing_to_send", `Read ${Math.min(notes.length, NOTES_PER_TIDY)} notes; none needs tidying.`);
  else run.outcome(thread, "deferred", `Proposed a tidier version of ${proposed} notes for a person to send or discard.`);
}
