import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Mission Control's own Postgres. Each file in src/server/migrations runs once, in name order,
// inside a transaction, and is recorded in schema_migrations.

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");

// searchPath puts every table in one schema. The tests use it so each test file has its own tables.
export function createPool(connectionString: string, searchPath?: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, options: searchPath ? `-c search_path=${searchPath}` : undefined });
}

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    // One process at a time: a second one waits here instead of running the same file twice.
    await client.query("SELECT pg_advisory_lock(hashtext('teammates_migrations'))");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((row) => row.name));
    const applied: string[] = [];
    const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
    for (const name of files) {
      if (done.has(name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(path.join(MIGRATIONS, name), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('teammates_migrations'))").catch(() => {});
    client.release();
  }
}

// Runs work inside one transaction: all of it lands, or none of it does.
export async function inTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
