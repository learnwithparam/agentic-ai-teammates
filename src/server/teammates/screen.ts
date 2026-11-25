import { z } from "zod";
import { modelSchema } from "../model-schema";
import { prompt } from "../prompts";
import type { Run } from "../run";

// The one check every teammate runs on text from outside before a model writes from it. The
// invoice teammate's own screen asks the same question, and also whether the document is a bill.

const SCREEN_RULES = prompt(import.meta.url, "screen");
const Screened = modelSchema("screen", z.object({ injection: z.boolean(), reason: z.string().min(1).max(300) }));

export async function screen(run: Run, text: string): Promise<{ injection: boolean; reason: string } | { handed: string }> {
  const messages = [
    { role: "system" as const, content: SCREEN_RULES },
    { role: "user" as const, content: `<text>\n${text.slice(0, 30_000)}\n</text>` },
  ];
  const answer = await run.structured({ task: "screen", risk: "high", messages, maxTokens: 600 }, Screened.format, Screened.parse);
  return "handed" in answer ? answer : answer.value;
}
