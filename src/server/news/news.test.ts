import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { newsGraph } from "../teammates/news-graph";
import { articleText, isPublicAddress, readArticle } from "./article";
import { canonicalUrl, dedupe, EDITION_SIZE, editionProblems } from "./edition";
import { feedStories, gdeltStories, hackerNewsStory, type Story } from "./sources";

// The news rules that need no model and no network: what counts as the same story, what an
// edition may hold, which sources' stories are kept, and which addresses the reader refuses.

const NOW = new Date("2026-11-25T12:00:00Z");

function storyAt(url: string, title: string, publishedAt: string): Story {
  return { url, title, source: "Example News", publishedAt, snippet: "" };
}

const CARD = {
  headline: "A city opens its bus data",
  bullets: ["The data is live.", "It covers every route.", "Anyone can use it."],
  whyItMatters: "Riders can see delays as they happen.",
  url: "https://example.org/buses",
  source: "Example News",
  topic: "Cities",
};

test("one page is one link, whatever tracking or slash it carries", () => {
  assert.equal(canonicalUrl("https://www.Example.org/buses/?utm_source=x&b=2&a=1#top"), "https://example.org/buses?a=1&b=2");
  assert.equal(canonicalUrl("https://example.org/"), "https://example.org");
});

test("the same story twice, by link or by headline, is kept once, newest first", () => {
  const kept = dedupe([
    storyAt("https://example.org/a", "Buses go live", "2026-11-25T08:00:00Z"),
    storyAt("https://www.example.org/a/?utm_medium=rss", "Another title", "2026-11-25T09:00:00Z"),
    storyAt("https://other.example/b", "Buses go LIVE!", "2026-11-25T10:00:00Z"),
    storyAt("https://example.org/c", "Trams go live", "2026-11-25T11:00:00Z"),
  ]);
  assert.deepEqual(kept.map((story) => story.url), ["https://example.org/c", "https://example.org/a"]);
});

test("an edition may hold only collected, new, distinct stories within the card limits", () => {
  const collected = ["https://example.org/buses"];
  assert.deepEqual(editionProblems([CARD], collected, []), []);
  assert.match(editionProblems([], collected, []).join(), /no cards/);
  assert.match(editionProblems([{ ...CARD, url: "https://made.up/x" }], collected, []).join(), /no source gave today/);
  assert.match(editionProblems([CARD], collected, ["https://www.example.org/buses/"]).join(), /earlier edition/);
  assert.match(editionProblems([CARD, CARD], collected, []).join(), /repeats a story/);
  assert.match(editionProblems([{ ...CARD, bullets: ["Only one."] }], collected, []).join(), /limits/);
  assert.match(editionProblems(Array(EDITION_SIZE + 1).fill(CARD), collected, []).join(), /the most is/);
});

test("a feed keeps only dated stories from the last two days", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>
    <item><title>New today</title><link>https://example.org/today</link><pubDate>Wed, 25 Nov 2026 08:00:00 GMT</pubDate><description>&lt;p&gt;Fresh&lt;/p&gt;</description></item>
    <item><title>Last week</title><link>https://example.org/old</link><pubDate>Wed, 18 Nov 2026 08:00:00 GMT</pubDate></item>
    <item><title>No date</title><link>https://example.org/undated</link></item>
  </channel></rss>`;
  const stories = feedStories(xml, { name: "Example", url: "https://example.org/feed" }, NOW);
  assert.deepEqual(stories.map((story) => [story.url, story.snippet]), [["https://example.org/today", "Fresh"]]);
});

test("Hacker News keeps only live stories with a link at or over the score", () => {
  const item = { type: "story", title: "A tool", url: "https://example.org/tool", score: 200, time: NOW.getTime() / 1000 - 3600 };
  assert.equal(hackerNewsStory(item, 150, NOW)?.url, "https://example.org/tool");
  assert.equal(hackerNewsStory({ ...item, score: 100 }, 150, NOW), null);
  assert.equal(hackerNewsStory({ ...item, url: undefined }, 150, NOW), null);
  assert.equal(hackerNewsStory({ ...item, dead: true }, 150, NOW), null);
});

test("GDELT's dates are read, and a plain-text answer is an error, not an empty day", () => {
  const body = JSON.stringify({ articles: [{ url: "https://example.org/g", title: "Studio news", seendate: "20261125T080000Z", domain: "example.org" }] });
  assert.equal(gdeltStories(body, NOW)[0].publishedAt, "2026-11-25T08:00:00.000Z");
  assert.throws(() => gdeltStories("Please limit requests to one every 5 seconds", NOW), /did not answer with results/);
});

test("the reader refuses every address that is not on the public internet", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "fd00::1", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2001:0:4136:e378::1", "2001:db8::1", "fec0::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["93.184.215.14", "2606:4700::6810:84e5", "::ffff:93.184.215.14"]) assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(readArticle("http://127.0.0.1:8788/healthz"), /not on the public internet/);
  await assert.rejects(readArticle("http://[::ffff:127.0.0.1]/"), /not on the public internet/);
  await assert.rejects(readArticle("file:///etc/passwd"), /Only web pages/);
});

test("the reader keeps an article's text and leaves the page around it", () => {
  const paragraph = "The studio shipped a new type family this week, and its clients can license it now. ".repeat(8);
  const html = `<html><head><title>Type news</title></head><body><nav>Home About Shop</nav><article><h1>Type news</h1><p>${paragraph}</p><p>${paragraph}</p></article><footer>Cookies</footer></body></html>`;
  const { text } = articleText(html);
  assert.match(text, /new type family/);
  assert.doesNotMatch(text, /Home About Shop/);
});

test("the news graph has one node per step of the day", async () => {
  const graph = newsGraph(new MemorySaver(), () => {
    throw new Error("Building the graph runs nothing.");
  });
  const nodes = Object.keys((await graph.getGraphAsync()).nodes).filter((name) => !name.startsWith("__"));
  assert.deepEqual(nodes, ["collect", "dedupe", "select", "write", "check", "publish", "wait", "publish_approved"]);
});
