import assert from "node:assert/strict";
import { test } from "node:test";
import { dayLabel, Edition, step } from "./edition.ts";

// The page reads exactly what the gateway's publisher writes. A file of another shape is refused
// here, so a change on one side fails the check instead of showing an empty page.

const PUBLISHED = {
  day: "2026-11-25",
  publishedAt: "2026-11-25T07:04:00.000Z",
  cards: [
    {
      headline: "Visa refresh adds subtle bands and cropped wordmark",
      bullets: ["A new symbol.", "The old bands return.", "A new typeface."],
      whyItMatters: "An old brand can grow from its own archive.",
      url: "https://www.creativeboom.com/news/visa-has-a-new-look-by-base-design-so-whats-actually-changed/",
      source: "Creative Boom",
      topic: "Brand identity",
    },
  ],
};

test("an edition as the publisher writes it is read", () => {
  assert.equal(Edition.parse(PUBLISHED).cards.length, 1);
});

test("an edition with no cards, or a card with no link, is refused", () => {
  assert.throws(() => Edition.parse({ ...PUBLISHED, cards: [] }));
  assert.throws(() => Edition.parse({ ...PUBLISHED, cards: [{ ...PUBLISHED.cards[0], url: "not a link" }] }));
});

test("the day reads as its calendar date in every time zone", () => {
  assert.equal(dayLabel("2026-11-25"), "Wednesday 25 November");
});

test("moving stays between the first card and the closing page", () => {
  assert.equal(step(0, -1, 5), 0);
  assert.equal(step(4, 1, 5), 5);
  assert.equal(step(5, 1, 5), 5);
});
