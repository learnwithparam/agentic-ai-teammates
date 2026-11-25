import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { testDatabase } from "./test-database";

let pool: Pool;
let close: () => Promise<void>;

before(async () => {
  ({ pool, close } = await testDatabase());
});
after(async () => close());

// A Postgres restart ends every idle connection. The process must keep going and the next query must work.
test("an idle connection that Postgres ends does not stop the process", async () => {
  const [killer, ...held] = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
  const pids = await Promise.all(held.map(async (client) => (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid));
  for (const client of held) client.release();
  try {
    await killer.query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [pids]);
  } finally {
    killer.release();
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { rows } = await pool.query<{ one: number }>("SELECT 1 AS one");
  assert.equal(rows[0].one, 1);
});
