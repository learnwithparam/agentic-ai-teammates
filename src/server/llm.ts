import { observeOpenAI } from "@langfuse/openai";
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
  outputTokens: number;
  costUsd: number;
};

export function createModelClient(apiKey: string) {
  const client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey, maxRetries: 2, timeout: 120_000 });

  return async function callModel(request: ModelRequest): Promise<ModelAnswer> {
    const { trace } = request;
    const observed = observeOpenAI(client, {
      generationName: `${trace.task} (${request.tier})`,
      sessionId: trace.runId,
      userId: `${trace.company}/${trace.teammate}`,
      tags: [trace.teammate, trace.task, request.tier],
    });
    const response = await observed.chat.completions.create({
      model: MODELS[request.tier].id,
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
      outputTokens: usage.completion_tokens,
      costUsd: usage.cost,
    };
  };
}

// The fast tier thinks briefly before answering; long thinking costs more than the task is worth.
// The strong tier never gets a temperature: it does not accept one.
function openRouterOptions(tier: Tier) {
  const reasoning = tier === "fast" ? { effort: "low" } : { effort: "medium" };
  return { provider: { require_parameters: true }, usage: { include: true }, reasoning } as Record<string, unknown>;
}

export type CallModel = ReturnType<typeof createModelClient>;
