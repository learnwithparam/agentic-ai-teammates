import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { createPool, migrate } from "./db";
import { setting } from "./env";
import { ensureTeammates } from "./teammates/ensure";

// The tests run against a real Postgres: the tests' own database from npm run setup. Each test
// file gets a new schema with every migration applied, so files run side by side without sharing rows.
// A world app passes its own migrations folder.
export async function testDatabase(folder?: string): Promise<{ pool: Pool; close: () => Promise<void> }> {
  const address = setting("TEST_DATABASE_URL");
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const owner = createPool(address);
  await owner.query(`CREATE SCHEMA ${schema}`);
  const pool = createPool(address, schema);
  await migrate(pool, folder);
  // The teammates' own database also gets each company's teammates, as startup gives them.
  if (!folder) await ensureTeammates(pool);
  const close = async () => {
    await pool.end();
    await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    await owner.end();
  };
  return { pool, close };
}
