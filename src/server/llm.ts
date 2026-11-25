import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import OpenAI from "openai";
import { MODELS, type Tier } from "./models";

// The one place a model is called. Only the gateway imports this file, because only the gateway
// holds the OpenRouter key. Every call is a real call; there is no other path to an answer.

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolSpec = OpenAI.Chat.Completions.ChatCompletionFunctionTool;

export type ModelRequest = {
  tier: Tier;
  messages: ChatMessage[];
  // A JSON schema the answer must follow. Without one, the model may answer with tool calls.
  schema?: { name: string; schema: Record<string, unknown> };
  tools?: ToolSpec[];
  maxTokens: number;
  // Langfuse groups every call of one run under the run's id.
  trace: { runId: string; teammate: string; company: string; task: string };
};

export type ModelAnswer = {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  inputTokens: number;
  // The part of inputTokens the provider read from its prompt cache, as it reports it.
  cachedTokens?: number;
  outputTokens: number;
  costUsd: number;
};

export function createModelClient(apiKey: string) {
  const client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey, maxRetries: 2, timeout: 120_000 });

  async function callModel(request: ModelRequest): Promise<ModelAnswer> {
    const { trace } = request;
    const model = MODELS[request.tier].id;
    // One generation per call, inside the run's trace. OpenRouter's own cost goes on it, so
    // Langfuse shows what was paid, not a guess from a price list.
    const attributes = { sessionId: trace.runId, userId: `${trace.company}/${trace.teammate}`, tags: [trace.teammate, trace.task, request.tier] };
    return propagateAttributes(attributes, () =>
      startActiveObservation(
        `${trace.task} (${request.tier})`,
        async (generation) => {
          generation.update({ model, input: request.messages, modelParameters: { max_tokens: request.maxTokens } });
          const answer = await send(request, model);
          generation.update({
            output: answer.content ?? answer.toolCalls,
            usageDetails: { input: answer.inputTokens, output: answer.outputTokens, cache_read_input_tokens: answer.cachedTokens ?? 0 },
            costDetails: { total: answer.costUsd },
          });
          return answer;
        },
        { asType: "generation" },
      ),
    );
  }

  async function send(request: ModelRequest, model: string): Promise<ModelAnswer> {
    const response = await client.chat.completions.create({
      model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      ...(request.schema ? { response_format: { type: "json_schema", json_schema: { ...request.schema, strict: true } } } : {}),
      ...(request.tools?.length ? { tools: request.tools, tool_choice: "auto" as const } : {}),
      // OpenRouter only sends the call to a provider that honours every parameter above.
      ...openRouterOptions(request.tier),
    });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("The model sent no answer.");
    const usage = response.usage as (OpenAI.CompletionUsage & { cost?: number }) | undefined;
    if (!usage || typeof usage.cost !== "number") throw new Error("OpenRouter did not report what the call cost.");
    const toolCalls = (message.tool_calls ?? [])
      .filter((call) => call.type === "function")
      .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
    return {
      content: message.content ?? null,
      toolCalls,
      inputTokens: usage.prompt_tokens,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage.completion_tokens,
      costUsd: usage.cost,
    };
  }

  return callModel;
}

// The fast tier does not think. Given any effort, even low, it thought until max_tokens and sent cut-off
// JSON, so every quick check failed. The strong tier never gets a temperature: it does not accept one.
export function openRouterOptions(tier: Tier) {
  const reasoning = tier === "fast" ? { enabled: false } : { effort: "medium" };
  return { provider: { require_parameters: true }, usage: { include: true }, reasoning } as Record<string, unknown>;
}

export type CallModel = ReturnType<typeof createModelClient>;
