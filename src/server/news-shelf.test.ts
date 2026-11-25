import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { NewsShelf } from "./news-shelf";
import { testNewsShelf } from "./test-memory";

// The news shelf against the real S3 from npm run setup. Mission Control's news page reads
// exactly these files, so their names and order are the contract.

let shelf: NewsShelf;
let close: () => Promise<void>;

before(async () => {
  ({ shelf, close } = await testNewsShelf("https://mc.example"));
});
after(() => close());

const card = (headline: string) => ({
  headline,
  bullets: ["One.", "Two.", "Three."],
  whyItMatters: "It matters.",
  url: `https://example.org/${encodeURIComponent(headline)}`,
  source: "Example News",
  topic: "Cities",
});
const edition = (day: string, headline: string) => ({ day, publishedAt: `${day}T06:05:00.000Z`, cards: [card(headline)] });
const read = async (company: string, file: string) => {
  const text = await shelf.read(company, file);
  return text === null ? null : JSON.parse(text);
};

test("each edition is kept by day, today is the newest, and every day is listed once", async () => {
  assert.deepEqual(await shelf.publish("bramble", edition("2026-11-24", "Monday")), { url: "https://mc.example/news/?day=2026-11-24" });
  await shelf.publish("bramble", edition("2026-11-25", "Tuesday"));
  await shelf.publish("bramble", edition("2026-11-25", "Tuesday again"));
  // A late edition for an earlier day is kept, and does not take today's place.
  await shelf.publish("bramble", edition("2026-11-23", "Sunday"));

  assert.deepEqual(await read("bramble", "days.json"), ["2026-11-25", "2026-11-24", "2026-11-23"]);
  assert.equal((await read("bramble", "today.json")).cards[0].headline, "Tuesday again");
  assert.equal((await read("bramble", "2026-11-24.json")).cards[0].headline, "Monday");
});

test("a company reads only its own news, and only the shelf's own file names", async () => {
  await shelf.publish("bramble", edition("2026-11-26", "Bramble only"));
  assert.equal(await shelf.read("northwind", "today.json"), null);
  for (const file of ["../bramble/today.json", "today.txt", "2026-11-26.json.bak", "notes.json"]) {
    assert.equal(await shelf.read("bramble", file), null, file);
  }
});
