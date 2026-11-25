// The two model tiers every teammate uses, and the only place their ids and prices are written.
// scripts/check-models.ts compares this file with OpenRouter's live model list on every check.
//
// fast   reads and sorts: classify a tool call, extract an invoice, summarise.
// strong thinks harder: screen an event, investigate a failed invoice, write the approval brief, select the news.
//
// The router (router.ts) picks a tier for each call. A person is the step after strong.

export type Tier = "fast" | "strong";

export type ModelTier = {
  id: string;
  // US dollars per million tokens, as OpenRouter lists them.
  inputPerMillion: number;
  outputPerMillion: number;
  // What every call in this repo needs from the model.
  needs: readonly string[];
};

const NEEDS = ["tools", "tool_choice", "structured_outputs", "response_format"] as const;

export const MODELS: Record<Tier, ModelTier> = {
  fast: { id: "nvidia/nemotron-3.5-lightning", inputPerMillion: 0.07, outputPerMillion: 0.2, needs: NEEDS },
  strong: { id: "openai/gpt-6-luna", inputPerMillion: 0.1, outputPerMillion: 0.5, needs: NEEDS },
};

// What a call would cost before it is sent, used to check a run's dollar cap.
// The real cost comes back on each response as usage.cost and is what gets stored.
export function estimateCost(tier: Tier, inputTokens: number, outputTokens: number): number {
  const model = MODELS[tier];
  return (inputTokens * model.inputPerMillion + outputTokens * model.outputPerMillion) / 1_000_000;
}
