import { Annotation, type BaseCheckpointSaver, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import { INSTRUCTIONS } from "../../memory";
import { modelSchema } from "../../model-schema";
import { dedupe, EDITION_SIZE, editionProblems } from "../../news/edition";
import type { SourceReport, Story } from "../../news/sources";
import type { Run, StopReason } from "../../run";
import type { Card } from "../../tools";
import { screen } from "../screen";
import { prompt } from "../../prompts";

// The news teammate's day, as one LangGraph graph. The roles a newsroom has are nodes, not
// separate agents: only "select" and "write" call a model, and every other step is plain code.
// Each day is its own thread, so a run that stops part way picks up at its last finished step.
//
//   collect -> dedupe -> select -> write (screen each article first) -> check -> publish
//   publish needs a person: wait -> publish_approved

export type Result = { outcome: StopReason; note: string };
export type Decision = { status: "approved" | "denied"; approvalId: string };
export type Candidate = Story & { id: number };
type Pick = { storyId: number; why: string };

// A page with less text than this is a paywall, a cookie wall or a video, not an article to sum up.
export const MIN_ARTICLE_CHARS = 600;
// The model ranks a few more stories than an edition holds, since some pages cannot be read.
const MAX_PICKS = EDITION_SIZE + 3;

const State = Annotation.Root({
  day: Annotation<string>,
  audience: Annotation<string | null>,
  instructions: Annotation<string | null>,
  stories: Annotation<Candidate[]>,
  sources: Annotation<SourceReport[]>,
  picks: Annotation<Pick[]>,
  cards: Annotation<Card[]>,
  // Stories the writer passed over, and why. The run's note shows them.
  skipped: Annotation<string[]>,
  approvalId: Annotation<string | null>,
  decision: Annotation<Decision | null>,
  result: Annotation<Result | null>,
});
type State = typeof State.State;

export const FRESH_STATE = { audience: null, instructions: null, stories: [], sources: [], picks: [], cards: [], skipped: [], approvalId: null, decision: null, result: null };

const Why = z.string().min(1).max(200);
const PickSchema = z.object({ storyId: z.number().int(), why: Why });
const Selection = modelSchema("selection", z.object({ picks: z.array(PickSchema).max(MAX_PICKS) }));

const Written = modelSchema(
  "card",
  z.object({
    // False when the text does not hold a news story this audience can use, such as a sale page.
    usable: z.boolean(),
    headline: z.string().min(1).max(90),
    bullets: z.array(z.string().min(1).max(160)).length(3),
    whyItMatters: z.string().min(1).max(220),
    topic: z.string().min(1).max(40),
  }),
);

const CandidateSchema = z.object({
  id: z.number(),
  url: z.string(),
  title: z.string(),
  source: z.string(),
  publishedAt: z.string(),
  snippet: z.string(),
});
const SourceSchema = z.object({ name: z.string(), stories: z.number(), error: z.string().nullable() });
const Collected = z.object({ audience: z.string(), stories: z.array(CandidateSchema), sources: z.array(SourceSchema) });
const Article = z.object({ text: z.string().nullable(), reason: z.string().nullable() });
const Instructions = z.object({ text: z.string().nullable() });

const SELECT_RULES = prompt(import.meta.url, "select");

const WRITE_RULES = prompt(import.meta.url, "write");

export function newsGraph(checkpointer: BaseCheckpointSaver, runOf: (runId: string) => Run) {
  const runFor = (config: LangGraphRunnableConfig) => runOf(String(config.configurable?.run_id));
  const threadOf = (config: LangGraphRunnableConfig) => String(config.configurable?.thread_id);

  function withReaders(rules: string, state: State): string {
    const parts = [rules, `The audience: ${state.audience}`];
    if (state.instructions) parts.push(`What a person at the company asked for. Follow it unless it conflicts with the rules above:\n${state.instructions}`);
    return parts.join("\n\n");
  }

  async function collect(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
    const run = runFor(config);
    const thread = threadOf(config);
    const collected = await run.tool(thread, "news.collect", { day: state.day });
    if (collected.status !== "done") return { result: { outcome: "handed_to_human", note: collected.status === "denied" ? collected.reason : "Collecting the news asked for a person." } };
    const { audience, stories, sources } = Collected.parse(collected.result);
    const instructions = await run.tool(thread, "memory.read", { path: INSTRUCTIONS });
    const failed = sources.filter((source) => source.error);
    if (failed.length) await run.note("note", "Some news sources did not answer", { sources: failed });
    if (stories.length === 0) return { sources, result: { outcome: "nothing_to_send", note: "No source had a new story today." } };
    return { audience, stories, sources, instructions: instructions.status === "done" ? Instructions.parse(instructions.result).text : null };
  }

  async function dedupeNode(state: State): Promise<Partial<State>> {
    const kept = new Set(dedupe(state.stories).map((story) => story.url));
    return { stories: state.stories.filter((story) => kept.has(story.url)) };
  }

  async function select(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
    const run = runFor(config);
    const list = state.stories.map((story) => ({ id: story.id, title: story.title, source: story.source, snippet: story.snippet.slice(0, 300) }));
    const messages = [
      { role: "system" as const, content: withReaders(SELECT_RULES, state) },
      { role: "user" as const, content: `Today's stories:\n${JSON.stringify(list)}` },
    ];
    const answer = await run.structured({ task: "select", risk: "low", messages, maxTokens: 1500 }, Selection.format, Selection.parse);
    if ("handed" in answer) return { result: { outcome: "handed_to_human", note: answer.handed } };
    // The model may only pick from the list, each story once.
    const ids = new Set(state.stories.map((story) => story.id));
    const seen = new Set<number>();
    const picks = answer.value.picks.filter((pick) => ids.has(pick.storyId) && !seen.has(pick.storyId) && seen.add(pick.storyId));
    if (picks.length === 0) return { picks, result: { outcome: "nothing_to_send", note: "Nothing today was worth a card." } };
    return { picks };
  }

  // Reads each pick and writes its card, best first, until the edition is full.
  async function write(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
    const run = runFor(config);
    const thread = threadOf(config);
    const cards: Card[] = [];
    const skipped: string[] = [];
    for (const pick of state.picks) {
      if (cards.length >= EDITION_SIZE) break;
      const story = state.stories.find((candidate) => candidate.id === pick.storyId)!;
      const read = await run.tool(thread, "news.read", { day: state.day, storyId: story.id });
      const article = read.status === "done" ? Article.parse(read.result) : { text: null, reason: "The gateway did not read it." };
      if (!article.text || article.text.length < MIN_ARTICLE_CHARS) {
        skipped.push(`${story.title}: ${article.reason ?? "the page holds too little text"}`);
        continue;
      }
      // An article is text from the open web, so it is screened before a model writes from it.
      const screened = await screen(run, article.text);
      if ("handed" in screened) return { cards, skipped, result: { outcome: "handed_to_human", note: screened.handed } };
      if (screened.injection) {
        skipped.push(`${story.title}: the page holds instructions for an AI (${screened.reason})`);
        continue;
      }
      const messages = [
        { role: "system" as const, content: withReaders(WRITE_RULES, state) },
        { role: "user" as const, content: `Why the editor chose it: ${pick.why}\nTitle: ${story.title}\nSource: ${story.source}\n\nArticle text:\n${article.text}` },
      ];
      const answer = await run.structured({ task: "summarize", risk: "low", messages, maxTokens: 700 }, Written.format, Written.parse);
      if ("handed" in answer) return { cards, skipped, result: { outcome: "handed_to_human", note: answer.handed } };
      if (!answer.value.usable) {
        skipped.push(`${story.title}: the page is not a news story`);
        continue;
      }
      const { headline, bullets, whyItMatters, topic } = answer.value;
      // The link and the source come from the collected story, never from the model.
      const label = topic.charAt(0).toUpperCase() + topic.slice(1);
      cards.push({ headline, bullets, whyItMatters, topic: label, url: story.url, source: story.source });
    }
    if (skipped.length) await run.note("note", "Some picks did not become cards", { skipped });
    if (cards.length === 0) return { cards, skipped, result: { outcome: "nothing_to_send", note: "None of the chosen stories could be read." } };
    return { cards, skipped };
  }

  // The same rules the gateway applies, run first so a broken edition never asks a person.
  async function check(state: State): Promise<Partial<State>> {
    const problems = editionProblems(state.cards, state.stories.map((story) => story.url), []);
    if (problems.length) return { result: { outcome: "handed_to_human", note: problems.join(" ") } };
    return {};
  }

  function published(state: State, result: { status: string }, by: string | null): Result {
    const count = `${state.cards.length} ${state.cards.length === 1 ? "story" : "stories"}`;
    if (result.status === "draft") return { outcome: "sent", note: `The news for ${state.day} (${count}) waits as a draft, since this teammate is quiet.` };
    return { outcome: "sent", note: `The news for ${state.day} (${count}) is on its way to the page${by ? `, approved by ${by}` : ""}.` };
  }

  async function publish(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
    const run = runFor(config);
    const result = await run.tool(threadOf(config), "news.publish", { day: state.day, cards: state.cards });
    if (result.status === "needs_approval") return { approvalId: result.approvalId };
    if (result.status === "denied") return { result: { outcome: "handed_to_human", note: result.reason } };
    return { result: published(state, z.object({ status: z.string() }).parse(result.result), null) };
  }

  // The run ends here. A person's decision arrives as an inbox event and resumes the thread.
  async function wait(state: State): Promise<Partial<State>> {
    const decision = interrupt<{ approvalId: string }, Decision>({ approvalId: state.approvalId! });
    return { decision };
  }

  async function publishApproved(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
    if (state.decision!.status === "denied") return { result: { outcome: "nothing_to_send", note: `The news for ${state.day} was turned down by a person.` } };
    const run = runFor(config);
    const result = await run.tool(threadOf(config), "news.publish", { day: state.day, cards: state.cards }, state.approvalId!);
    if (result.status !== "done") return { result: { outcome: "handed_to_human", note: result.status === "denied" ? result.reason : "The approved news asked for a person again." } };
    return { result: published(state, z.object({ status: z.string() }).parse(result.result), "a person") };
  }

  const next = (step: string) => (state: State) => (state.result ? END : step);

  return new StateGraph(State)
    .addNode("collect", collect)
    .addNode("dedupe", dedupeNode)
    .addNode("select", select)
    .addNode("write", write)
    .addNode("check", check)
    .addNode("publish", publish)
    .addNode("wait", wait)
    .addNode("publish_approved", publishApproved)
    .addEdge(START, "collect")
    .addConditionalEdges("collect", next("dedupe"), ["dedupe", END])
    .addEdge("dedupe", "select")
    .addConditionalEdges("select", next("write"), ["write", END])
    .addConditionalEdges("write", next("check"), ["check", END])
    .addConditionalEdges("check", next("publish"), ["publish", END])
    .addConditionalEdges("publish", (state) => (state.approvalId && !state.result ? "wait" : END), ["wait", END])
    .addEdge("wait", "publish_approved")
    .addEdge("publish_approved", END)
    .compile({ checkpointer });
}
