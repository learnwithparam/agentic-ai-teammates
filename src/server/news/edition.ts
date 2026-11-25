import { Card } from "../tools/shapes";
import type { Story } from "./sources";

// The rules for a day's edition that need no model. The graph runs them before it publishes,
// and the gateway runs them again on news.publish, because only the gateway's records count.

// The most cards in one edition, and the most stories the model chooses from.
export const EDITION_SIZE = 5;
export const MAX_CANDIDATES = 80;

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid)$/i;

// One form for every link to the same page: no tracking, no fragment, no www, no closing slash.
export function canonicalUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

function titleKey(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

// Keeps the first of each story: the same page by link, or the same headline from two sources.
// Newest first, so the model sees today's news before yesterday's.
export function dedupe(stories: Story[]): Story[] {
  const urls = new Set<string>();
  const titles = new Set<string>();
  const kept: Story[] = [];
  for (const story of stories) {
    const url = canonicalUrl(story.url);
    const title = titleKey(story.title);
    if (urls.has(url) || titles.has(title)) continue;
    urls.add(url);
    titles.add(title);
    kept.push(story);
  }
  return kept.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, MAX_CANDIDATES);
}

// Why an edition must not go out, or an empty list when it may.
export function editionProblems(cards: unknown[], collected: string[], published: string[]): string[] {
  const problems: string[] = [];
  if (cards.length === 0) problems.push("The edition has no cards.");
  if (cards.length > EDITION_SIZE) problems.push(`The edition has ${cards.length} cards; the most is ${EDITION_SIZE}.`);
  const known = new Set(collected.map(canonicalUrl));
  const before = new Set(published.map(canonicalUrl));
  const seen = new Set<string>();
  cards.forEach((raw, index) => {
    const card = Card.safeParse(raw);
    if (!card.success) {
      problems.push(`Card ${index + 1} breaks the card's limits: ${card.error.issues[0]?.message ?? "invalid"}.`);
      return;
    }
    const url = canonicalUrl(card.data.url);
    if (!known.has(url)) problems.push(`Card ${index + 1} links to ${card.data.url}, which no source gave today.`);
    if (before.has(url)) problems.push(`Card ${index + 1} was published in an earlier edition.`);
    if (seen.has(url)) problems.push(`Card ${index + 1} repeats a story already in this edition.`);
    seen.add(url);
  });
  return problems;
}
