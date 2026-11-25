import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { Pool } from "pg";
import type { FileSource, MailSource } from "./adapters/types";
import { COMPANIES } from "./people";
import { renewWatches } from "./subscriptions";
import { testDatabase } from "./test-database";

// The gateway keeps one subscription per app and company. It renews one that is about to run
// out. It moves one at once when HOOKS_URL changes, so notices never go to an old address.

let pool: Pool;
let close: () => Promise<void>;
const week = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

// Records what the gateway asked the world apps to do. Only the watch calls are used here.
function worldApps() {
  const calls: string[] = [];
  let channel = 0;
  const mail = (company: string) => ({
    watch: async (address: string) => {
      calls.push(`mail ${company} ${address}`);
      return { historyId: "1", expiration: week() };
    },
  }) as unknown as MailSource;
  const files = {
    watch: async (address: string) => {
      channel += 1;
      calls.push(`drive ${address} -> channel-${channel}`);
      return { channelId: `channel-${channel}`, expiration: week() };
    },
    stopWatch: async (channelId: string) => {
      calls.push(`stop ${channelId}`);
    },
  } as unknown as FileSource;
  return { calls, mail, files };
}

before(async () => {
  ({ pool, close } = await testDatabase());
});
after(() => close());
beforeEach(() => pool.query("DELETE FROM subscriptions"));

test("a fresh subscription is kept until it nears its end", async () => {
  const apps = worldApps();
  const first = await renewWatches({ pool, hooksUrl: "http://localhost:8790", ...apps });
  assert.equal(first.length, 2 * Object.keys(COMPANIES).length);
  assert.deepEqual(await renewWatches({ pool, hooksUrl: "http://localhost:8790", ...apps }), []);
});

test("a new hooks address moves every subscription and stops the old drive channel", async () => {
  const apps = worldApps();
  await renewWatches({ pool, hooksUrl: "http://localhost:8787", ...apps });
  apps.calls.length = 0;

  const moved = await renewWatches({ pool, hooksUrl: "http://localhost:8790", ...apps });

  assert.equal(moved.length, 2 * Object.keys(COMPANIES).length);
  assert.ok(apps.calls.every((call) => !call.includes(":8787")), apps.calls.join("\n"));
  assert.ok(apps.calls.includes("mail bramble http://localhost:8790/hooks/lmail/bramble"), apps.calls.join("\n"));
  assert.ok(apps.calls.includes("stop channel-1"), apps.calls.join("\n"));
  const { rows } = await pool.query<{ address: string }>("SELECT DISTINCT address FROM subscriptions");
  assert.ok(rows.every((row) => row.address.startsWith("http://localhost:8790/")));
});
