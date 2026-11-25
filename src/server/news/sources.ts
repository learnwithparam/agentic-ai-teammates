import Exa from "exa-js";
import { parseFeed } from "feedsmith";
import { z } from "zod";
import type { Feed, NewsDesk } from "./desk";

// The news sources. Each one is a real service, and each runs on its own: one that fails is
// reported by name, and the edition goes on with the rest. Only stories from the last two days
// are kept, and a story without a date is dropped, since its age cannot be checked.

export type Story = { url: string; title: string; source: string; publishedAt: string; snippet: string };
export type SourceReport = { name: string; stories: number; error: string | null };

export const FRESH_HOURS = 48;
const HOUR_MS = 3_600_000;
const SNIPPET = 600;
const TIMEOUT_MS = 20_000;
const HN_STORIES = 60;
const GDELT_WAIT_MS = 6000;

export function plainText(html: string | undefined | null): string {
  return (html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function fresh(publishedAt: Date, now: Date): boolean {
  const age = now.getTime() - publishedAt.getTime();
  return age >= -HOUR_MS && age <= FRESH_HOURS * HOUR_MS;
}

function story(url: string | undefined, title: string | undefined, source: string, date: string | undefined, snippet: string, now: Date): Story | null {
  if (!url || !title || !date || !/^https?:\/\//.test(url)) return null;
  const publishedAt = new Date(date);
  if (Number.isNaN(publishedAt.getTime()) || !fresh(publishedAt, now)) return null;
  return { url, title: plainText(title).slice(0, 300), source, publishedAt: publishedAt.toISOString(), snippet: plainText(snippet).slice(0, SNIPPET) };
}

class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

async function get(url: string): Promise<Response> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, { headers: { "User-Agent": "agentic-ai-teammates news reader" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    // Node reports every network failure as "fetch failed"; the cause says which one it was.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
    throw new SourceError(`${host} could not be reached: ${cause}`, null);
  }
  if (!response.ok) throw new SourceError(`${host} answered ${response.status}.`, response.status);
  return response;
}

// ---------- RSS and Atom ----------

export function feedStories(xml: string, feed: Feed, now: Date): Story[] {
  const parsed = parseFeed(xml);
  const stories: (Story | null)[] = [];
  if (parsed.format === "atom") {
    for (const entry of parsed.feed.entries ?? []) {
      const link = entry.links?.find((candidate) => !candidate.rel || candidate.rel === "alternate")?.href;
      const summary = entry.summary?.value ?? entry.content?.value ?? "";
      stories.push(story(link, entry.title?.value, feed.name, entry.published ?? entry.updated, summary, now));
    }
  } else if (parsed.format === "rss") {
    for (const item of parsed.feed.items ?? []) stories.push(story(item.link, item.title, feed.name, item.pubDate, item.description ?? "", now));
  } else {
    throw new Error(`${feed.name} is a ${parsed.format} feed, which this reader does not take.`);
  }
  return stories.filter((found) => found !== null);
}

async function rss(feed: Feed, now: Date): Promise<Story[]> {
  return feedStories(await (await get(feed.url)).text(), feed, now);
}

// ---------- Hacker News ----------

const HnItem = z.object({
  type: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  score: z.number().optional(),
  time: z.number(),
  dead: z.boolean().optional(),
});

export function hackerNewsStory(raw: unknown, minScore: number, now: Date): Story | null {
  const item = HnItem.safeParse(raw);
  if (!item.success || item.data.type !== "story" || item.data.dead || (item.data.score ?? 0) < minScore) return null;
  const { title, url, score, time } = item.data;
  return story(url, title, "Hacker News", new Date(time * 1000).toISOString(), `${title}. ${score} points on Hacker News.`, now);
}

async function hackerNews(minScore: number, now: Date): Promise<Story[]> {
  const base = "https://hacker-news.firebaseio.com/v0";
  const ids = z.array(z.number()).parse(await (await get(`${base}/topstories.json`)).json()).slice(0, HN_STORIES);
  const items = await Promise.all(ids.map(async (id) => (await get(`${base}/item/${id}.json`)).json()));
  return items.map((item) => hackerNewsStory(item, minScore, now)).filter((found) => found !== null);
}

// ---------- GDELT ----------

const GdeltArticle = z.object({ url: z.string(), title: z.string(), seendate: z.string(), domain: z.string() });
const GdeltArticles = z.object({ articles: z.array(GdeltArticle).default([]) });

// GDELT dates look like 20261125T143000Z.
export function gdeltStories(body: string, now: Date): Story[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    // GDELT answers a busy or malformed request in plain text, such as its rate limit notice.
    throw new Error(`GDELT did not answer with results: ${body.slice(0, 120)}`);
  }
  return GdeltArticles.parse(json)
    .articles.map((article) => {
      const date = article.seendate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
      return story(article.url, article.title, article.domain, date, article.title, now);
    })
    .filter((found) => found !== null);
}

async function gdelt(query: string, now: Date): Promise<Story[]> {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  const timespan = `${FRESH_HOURS}h`;
  url.search = new URLSearchParams({ query, mode: "artlist", format: "json", maxrecords: "50", timespan, sort: "hybridrel" }).toString();
  try {
    return gdeltStories(await (await get(url.toString())).text(), now);
  } catch (error) {
    // GDELT takes one request every five seconds from each caller. A 429 waits that long and asks once more.
    if (!(error instanceof SourceError && error.status === 429)) throw error;
    await new Promise((resolve) => setTimeout(resolve, GDELT_WAIT_MS));
    return gdeltStories(await (await get(url.toString())).text(), now);
  }
}

// ---------- Exa ----------

async function exa(client: Exa, query: string, now: Date): Promise<Story[]> {
  const since = new Date(now.getTime() - FRESH_HOURS * HOUR_MS).toISOString();
  const found = await client.search(query, { numResults: 20, category: "news", startPublishedDate: since, contents: { text: { maxCharacters: SNIPPET } } });
  return found.results
    .map((result) => {
      const source = new URL(result.url).hostname.replace(/^www\./, "");
      return story(result.url, result.title ?? undefined, source, result.publishedDate, result.text ?? "", now);
    })
    .filter((found) => found !== null);
}

// ---------- All of them ----------

export async function collectStories(desk: NewsDesk, exaKey: string | null, now = new Date()): Promise<{ stories: Story[]; sources: SourceReport[] }> {
  const jobs: { name: string; run: () => Promise<Story[]> }[] = [
    ...desk.feeds.map((feed) => ({ name: feed.name, run: () => rss(feed, now) })),
    { name: "Hacker News", run: () => hackerNews(desk.hackerNewsMinScore, now) },
    { name: "GDELT", run: () => gdelt(desk.gdeltQuery, now) },
  ];
  if (exaKey) {
    const client = new Exa(exaKey);
    jobs.push({ name: "Exa", run: () => exa(client, desk.exaQuery, now) });
  }
  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  const stories: Story[] = [];
  const sources = settled.map((result, index): SourceReport => {
    if (result.status === "fulfilled") {
      stories.push(...result.value);
      return { name: jobs[index].name, stories: result.value.length, error: null };
    }
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { name: jobs[index].name, stories: 0, error: reason.slice(0, 200) };
  });
  return { stories, sources };
}
