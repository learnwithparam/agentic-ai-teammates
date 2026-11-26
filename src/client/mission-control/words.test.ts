import assert from "node:assert/strict";
import { test } from "node:test";
import { axisTicks, onClock, tokensRead, volumeLine, waitingSince, workingDaysSince } from "./words";

test("the spend axis steps in round amounts and reaches past the highest day", () => {
  // The live chart once read $0, $0.0070, $0.01, $0.02 because its steps were 0.0075 apart.
  assert.deepEqual(axisTicks(0.023), [0, 0.01, 0.02, 0.03]);
  assert.deepEqual(axisTicks(0.02), [0, 0.005, 0.01, 0.015, 0.02]);
  assert.deepEqual(axisTicks(3.4), [0, 1, 2, 3, 4]);
  assert.deepEqual(axisTicks(0.005), [0, 0.002, 0.004, 0.006]);
  assert.deepEqual(axisTicks(0), [0]);
  for (const highest of [0.0003, 0.017, 0.9, 12, 480]) {
    const ticks = axisTicks(highest);
    const step = ticks[1] - ticks[0];
    const leading = Number((step / 10 ** Math.floor(Math.log10(step))).toPrecision(6));
    assert.ok([1, 2, 5].includes(leading), `${highest} steps by ${step}`);
    assert.ok(ticks[ticks.length - 1] >= highest, `${highest} fits under ${ticks.at(-1)}`);
  }
});

test("a run sheet says how many tokens came from the cache only when some did", () => {
  assert.equal(tokensRead({ tokens: 1200, cached_tokens: 0 }), "1,200 tokens");
  assert.equal(tokensRead({ tokens: 1200, cached_tokens: 800 }), "1,200 tokens, 800 read from the cache");
});

test("the Quiet switch says what the teammate wrote, leaving out what it did not do", () => {
  const none = { days: 14, onItsOwn: 0, released: 0, discarded: 0, waiting: 0 };
  assert.equal(volumeLine(none), "It has written nothing in the last 14 days.");
  assert.equal(volumeLine({ ...none, released: 3, discarded: 1 }), "In the last 14 days: 3 sent by a person, 1 thrown away.");
});

test("a card says how long it has waited once three working days have passed", () => {
  const thursday = new Date("2026-11-26T10:00:00");
  assert.equal(workingDaysSince("2026-11-24T09:00:00", thursday), 2);
  assert.equal(waitingSince("2026-11-24T09:00:00", thursday), null);
  assert.equal(waitingSince("2026-11-23T09:00:00", thursday), "Waiting since Mon 23 Nov");
  // A weekend does not count, so Friday's card is not old on Tuesday.
  assert.equal(workingDaysSince("2026-11-20T16:00:00", new Date("2026-11-24T10:00:00")), 2);
});

test("a schedule's next time reads on the company's clock, whatever the reader's clock", () => {
  assert.equal(onClock("2026-11-27T08:00:00Z", "Europe/Amsterdam"), "Fri 27 Nov, 09:00");
  assert.equal(onClock("2026-11-27T08:00:00Z", "Asia/Kolkata"), "Fri 27 Nov, 13:30");
});
