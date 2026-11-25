// npm run check runs this. It fails when a model in src/server/models.ts has left OpenRouter's
// live list. It also fails when the model lost a feature the teammates need, or its price
// changed. A model swap is then a one-file change that this check confirms.
import { fileURLToPath } from "node:url";
import { MODELS, type ModelTier } from "../src/server/models";

type LiveModel = { id: string; pricing: { prompt: string; completion: string }; supported_parameters: string[] };

const MODEL_LIST = "https://openrouter.ai/api/v1/models";

export function modelProblems(tier: string, model: ModelTier, live: LiveModel[]): string[] {
  const found = live.find((entry) => entry.id === model.id);
  if (!found) return [`${tier}: ${model.id} is not on OpenRouter's live list. Pick a live model in src/server/models.ts.`];
  const problems: string[] = [];
  for (const need of model.needs) {
    if (!found.supported_parameters.includes(need)) problems.push(`${tier}: ${model.id} no longer supports ${need}.`);
  }
  const inputPerMillion = Number(found.pricing.prompt) * 1_000_000;
  const outputPerMillion = Number(found.pricing.completion) * 1_000_000;
  if (Math.abs(inputPerMillion - model.inputPerMillion) > 1e-9) problems.push(`${tier}: input price is $${inputPerMillion}/M live, $${model.inputPerMillion}/M in models.ts.`);
  if (Math.abs(outputPerMillion - model.outputPerMillion) > 1e-9) problems.push(`${tier}: output price is $${outputPerMillion}/M live, $${model.outputPerMillion}/M in models.ts.`);
  return problems;
}

async function main() {
  const response = await fetch(MODEL_LIST, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`OpenRouter's model list answered ${response.status}.`);
  const live = ((await response.json()) as { data: LiveModel[] }).data;
  const problems = Object.entries(MODELS).flatMap(([tier, model]) => modelProblems(tier, model, live));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`check-models: ${Object.values(MODELS).map((model) => model.id).join(" and ")} are live, with tools, structured outputs and the prices in models.ts.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
