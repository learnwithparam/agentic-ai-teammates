import assert from "node:assert/strict";
import { test } from "node:test";
import { axisTicks } from "./words";

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
