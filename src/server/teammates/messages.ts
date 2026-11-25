import { z } from "zod";
import type { InboxEvent } from "../inbox";
import { ALWAYS_READ, INSTRUCTIONS, REPORTED } from "../memory";
import { CapReached, type Run } from "../run";
import { toolDefinition, type ToolName } from "../tools";
import type { TeammateDefinition } from "./define";

// What every teammate does when a person writes to it in Mission Control. The web server sets how
// far it may look. Someone who only views the teammate gets what the board already shows them.
// Only someone who may configure it gets the tools. Even then a message can never make it post,
// send or publish: "act" adds only the small writes that stay inside the company.

const Said = z.string().min(1);
export const Reach = z.enum(["board", "tools"]);
const Message = z.object({ messageId: z.uuid(), text: Said, from: Said, person: z.email(), reach: Reach });
type Message = z.infer<typeof Message>;
const MemoryText = z.object({ text: z.string().nullable() });

const ANSWER_RULES = `You are an AI teammate at a small company, answering a person who works with you.
Answer from the facts you are given and from what your tools find. Never guess or make up a number.
If you do not know, say so and say what would tell you.
The person may have sent several messages in a row. Answer them together, once.
You cannot post, send, approve or change anything from this conversation. If the person asks for that, say where they can do it on the board.
Write plain sentences, at most 120 words. No markdown tables.`;

const ACT_RULES = `You may also set a follow-up for yourself with team.follow_up when the person asks you to look at something later. You will tell them what you found.
When the person asks you to do your job on a document, such as posting a bill from an email, find it with your tools and hand it to yourself with team.hand_over. Every check still runs, under the person's own approval limit.
Keep a line of progress with memory.progress when a task will take more than this conversation, and a fact worth keeping with memory.note.
Say plainly what you set or handed over, and when.`;

// Takes the person.message events in a batch, answers each person once, and returns the rest.
// Three quick messages from one person get one answer, as the article's inbox batching asks.
export async function handleMessages(run: Run, events: InboxEvent[], definition: Pick<TeammateDefinition, "tools" | "capabilities">): Promise<InboxEvent[]> {
  const rest: InboxEvent[] = [];
  const byPerson = new Map<string, Message[]>();
  for (const event of events) {
    if (event.type !== "person.message" || event.source !== "person") {
      rest.push(event);
      continue;
    }
    const message = Message.parse(event.payload);
    byPerson.set(message.person, [...(byPerson.get(message.person) ?? []), message]);
  }
  for (const messages of byPerson.values()) {
    const last = messages.at(-1) as Message;
    const thread = `message:${last.messageId}`;
    try {
      await answer(run, thread, messages, chatTools(definition, messages));
    } catch (error) {
      if (!(error instanceof CapReached)) throw error;
      await run.reply(last.person, last.messageId, "I reached my limit for this run, so I could not look into this. Ask me again later.");
      run.outcome(thread, "handed_to_human", error.message);
    }
  }
  return rest;
}

// The tools one answer may use. Tools come only when every message in the batch may use them.
export function chatTools(definition: Pick<TeammateDefinition, "tools" | "capabilities">, messages: Message[]): ToolName[] {
  if (!messages.every((message) => message.reach === "tools")) return [];
  const { chat } = definition.capabilities;
  const writes = chat.mode === "act" ? definition.tools.filter((tool) => toolDefinition(tool).modelMayCall) : [];
  return ["memory.read", ...chat.reads, ...writes];
}

// The memory a run reads before it starts. Someone who only views the teammate gets its
// instructions alone. Otherwise it is the instructions, the index of notes, and what it already
// told this person: never what it told anyone else.
export async function standingMemory(run: Run, thread: string, reader: { person: string; reach: "board" | "tools" } | null): Promise<Record<string, string | null>> {
  const files: Record<string, string | null> = {};
  const text = (read: Awaited<ReturnType<Run["tool"]>>) => (read.status === "done" ? MemoryText.parse(read.result).text : null);
  const paths = reader?.reach === "board" ? [INSTRUCTIONS] : ALWAYS_READ.filter((path) => path !== REPORTED);
  for (const path of paths) files[path] = text(await run.tool(thread, "memory.read", { path }));
  // The gateway hands back only this person's lines, so no answer can quote what others were told.
  if (reader?.reach === "tools") files[REPORTED] = text(await run.tool(thread, "memory.reported", { person: reader.person }));
  return files;
}

async function answer(run: Run, thread: string, messages: Message[], tools: ToolName[]) {
  const last = messages.at(-1) as Message;
  const acts = tools.some((tool) => toolDefinition(tool).modelMayCall);
  // The fixed part comes first and the person's words last, so the fixed part can be cached.
  const reach = messages.every((message) => message.reach === "tools") ? "tools" : "board";
  const memory = await standingMemory(run, thread, { person: last.person, reach });
  const context = { yourMemory: memory, now: new Date().toISOString(), person: last.person, ...(await run.talkContext(last.person)) };
  const asked = messages.map((message) => message.text).join("\n\n");
  const result = await run.toolLoop({
    threadId: thread,
    task: "answer",
    risk: "low",
    maxTokens: 600,
    tools,
    messages: [
      { role: "system", content: acts ? `${ANSWER_RULES}\n${ACT_RULES}` : ANSWER_RULES },
      { role: "user", content: `What you know:\n${JSON.stringify(context, null, 2)}\n\n${last.from} asks:\n${asked}` },
    ],
  });
  if ("answer" in result) {
    await run.reply(last.person, last.messageId, result.answer);
    run.outcome(thread, "sent", messages.length > 1 ? `Answered ${last.from}'s ${messages.length} messages at once.` : `Answered ${last.from}.`);
  } else {
    await run.reply(last.person, last.messageId, "I could not find an answer to this. Someone on the team will need to look.");
    run.outcome(thread, "handed_to_human", result.handed);
  }
}
