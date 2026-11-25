import { z } from "zod";
import type { InboxEvent } from "../inbox";
import { INSTRUCTIONS } from "../memory";
import { CapReached, type Run } from "../run";
import type { ToolName } from "../tools";

// What every teammate does when a person writes to it in Mission Control. It answers from its own
// recent work and from tools that only read, so a question can never make it post, send or publish.

const Said = z.string().min(1);
const Message = z.object({ messageId: z.uuid(), text: Said, from: Said });
const MemoryText = z.object({ text: z.string().nullable() });

const ANSWER_RULES = `You are an AI teammate at a small company, answering a person who works with you.
Answer from the facts you are given and from what your tools find. Never guess or make up a number.
If you do not know, say so and say what would tell you.
You cannot post, send, approve or change anything from this conversation. If the person asks for that, say where they can do it on the board.
Write plain sentences, at most 120 words. No markdown tables.`;

// Handles the person.message events in a batch and returns the rest for the teammate's own work.
export async function handleMessages(run: Run, events: InboxEvent[], tools: ToolName[]): Promise<InboxEvent[]> {
  const rest: InboxEvent[] = [];
  for (const event of events) {
    if (event.type !== "person.message") {
      rest.push(event);
      continue;
    }
    const message = Message.parse(event.payload);
    const thread = `message:${message.messageId}`;
    try {
      await answer(run, thread, message, tools);
    } catch (error) {
      if (!(error instanceof CapReached)) throw error;
      await run.reply(message.messageId, "I reached my limit for this run, so I could not look into this. Ask me again later.");
      run.outcome(thread, "handed_to_human", error.message);
    }
  }
  return rest;
}

async function answer(run: Run, thread: string, message: z.infer<typeof Message>, tools: ToolName[]) {
  const instructions = await run.tool(thread, "memory.read", { path: INSTRUCTIONS });
  const context = {
    yourInstructions: instructions.status === "done" ? MemoryText.parse(instructions.result).text : null,
    ...(await run.talkContext()),
  };
  const result = await run.toolLoop({
    threadId: thread,
    task: "answer",
    risk: "low",
    maxTokens: 600,
    tools: ["memory.read", ...tools],
    messages: [
      { role: "system", content: ANSWER_RULES },
      { role: "user", content: `What you know:\n${JSON.stringify(context, null, 2)}\n\n${message.from} asks:\n${message.text}` },
    ],
  });
  if ("answer" in result) {
    await run.reply(message.messageId, result.answer);
    run.outcome(thread, "sent", `Answered ${message.from}.`);
  } else {
    await run.reply(message.messageId, "I could not find an answer to this. Someone on the team will need to look.");
    run.outcome(thread, "handed_to_human", result.handed);
  }
}
