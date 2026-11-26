import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { testDatabase } from "./test-database";
import { connectWhenReady } from "./db";

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

// A connection can also drop while a transaction holds it, between two queries. The pool no longer
// listens for its errors then, so without the pool's own handler the process stops.
test("a connection that drops while it is checked out does not stop the process", async () => {
  const held = await pool.connect();
  const { pid } = (await held.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0];
  await pool.query("SELECT pg_terminate_backend($1)", [pid]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(held.query("SELECT 1"));
  held.release(true);
  const { rows } = await pool.query<{ one: number }>("SELECT 1 AS one");
  assert.equal(rows[0].one, 1);
});

// A pool whose first answers are the given errors, then a connection.
function refusing(...codes: string[]) {
  let tries = 0;
  const client = { release() {} };
  const pool = {
    async connect() {
      const code = codes[tries++];
      if (code) throw Object.assign(new Error(`refused with ${code}`), { code });
      return client;
    },
  };
  return { pool: pool as unknown as Pool, client, tries: () => tries };
}

test("a process that starts while Postgres recovers waits for it, and a wrong password still fails at once", async () => {
  const recovering = refusing("57P03", "57P03");
  assert.equal(await connectWhenReady(recovering.pool, 1000, 1), recovering.client);
  assert.equal(recovering.tries(), 3);

  const wrong = refusing("28P01");
  await assert.rejects(connectWhenReady(wrong.pool, 1000, 1), /28P01/);
  assert.equal(wrong.tries(), 1);
});
