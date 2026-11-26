import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Mission Control's own Postgres. Each file in src/server/migrations runs once, in name order,
// inside a transaction, and is recorded in schema_migrations.

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");

// A date column comes back as the text Postgres stores, such as "2026-11-02". A Date at local
// midnight would move a bill's date by a day in some time zones.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

// searchPath puts every table in one schema. The tests use it so each test file has its own tables.
// One line for a database error in a loop's log. A refused connection has no message of its own, only a code.
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: string }).code;
  return error.message || code || error.name;
}

// An idle connection that drops, as every one does when Postgres restarts, is only logged: the pool
// opens a new one on the next query. Without this handler the drop would stop the whole process.
export function createPool(connectionString: string, searchPath?: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10, options: searchPath ? `-c search_path=${searchPath}` : undefined });
  pool.on("error", (error) => console.error(`A database connection dropped: ${error.message}`));
  // The pool stops listening while a connection is checked out, so each one gets its own handler.
  // The query in flight still fails, and the code that holds it decides what to do.
  pool.on("connect", (client) => {
    client.on("error", (error) => console.error(`A database connection in use dropped: ${error.message}`));
  });
  return pool;
}

// Postgres refuses connections while it starts or recovers after a crash. 57P03 is "cannot
// connect now". A process started in that window waits instead of dying.
const NOT_READY = new Set(["57P03", "ECONNREFUSED", "ECONNRESET"]);

export async function connectWhenReady(pool: pg.Pool, waitMs = 120_000, stepMs = 2000): Promise<pg.PoolClient> {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      return await pool.connect();
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (!NOT_READY.has(code) || Date.now() + stepMs > until) throw error;
      console.error(`Postgres is not taking connections yet (${describeError(error)}), so this process waits.`);
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }
}

// Each app passes its own folder of migrations; Mission Control's is the default.
export async function migrate(pool: pg.Pool, folder = MIGRATIONS): Promise<string[]> {
  const client = await connectWhenReady(pool);
  try {
    // One process at a time: a second one waits here instead of running the same file twice.
    await client.query("SELECT pg_advisory_lock(hashtext(current_database()))");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((row) => row.name));
    const applied: string[] = [];
    const files = readdirSync(folder).filter((file) => file.endsWith(".sql")).sort();
    for (const name of files) {
      if (done.has(name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(path.join(folder, name), "utf8"));
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
    await client.query("SELECT pg_advisory_unlock(hashtext(current_database()))").catch(() => {});
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
