import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import type { Pool, PoolClient } from "pg";
import { BUCKET as DRIVE_BUCKET } from "../apps/ldrive/store";
import { casesNamed, invoiceFolderId, SEND_SETTINGS, sendCases, smtpTransport } from "../data/invoices/send";
import { createPool, migrate } from "../src/server/db";
import { optionalSetting, requireSettings, type Setting, setting } from "../src/server/env";
import { MEMORY_BUCKET } from "../src/server/memory";
import { COMPANIES } from "../src/server/people";
import { createS3 } from "../src/server/s3";
import { ensureStandingSchedules } from "../src/server/scheduler-loop";
import { ensureTeammates } from "../src/server/teammates/ensure";
import { TEAMMATES } from "../src/server/teammates/registry";

// npm run demo:reset
//
// Puts Mission Control and the world apps back to a new install, then sends the morning's
// invoices, so every demo starts from the same place. It empties what the teammates did: runs,
// cards, timers, the conversation, memory, mail, files and bills. It keeps what connects the
// apps: sign-ins, members, watches and each teammate's read position, so nothing needs a
// restart. It refuses unless the settings file says DEMO_RESET=yes.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The invoices a demo morning brings. Two post and fall due within five days, so the invoice
// teammate asks Payments to pay them. One waits for a person, one has new bank details, and
// one tries to give the teammate orders.
export const MORNING = ["01-northwind-paper", "03-harbor-rent", "04-pixelforge-licence-in-body", "05-lumen-maths-error", "07-kestrel-new-bank", "14-kestrel-injection"];

// The tables each database keeps. Every other table is emptied, then gets its seed rows back.
export const KEEP = {
  missionControl: ["schema_migrations", "sessions", "sign_ins", "members", "subscriptions", "cursors", "teammates", "checkpoint_migrations"],
  lmail: ["schema_migrations", "domains", "mailboxes", "watches", "sessions", "sign_ins"],
  ldrive: ["schema_migrations", "folders", "channels", "sessions", "sign_ins"],
  quirkbooks: ["schema_migrations", "sessions", "sign_ins"],
};

// Why the reset must not run here, or null when it may.
export function refusal(source: NodeJS.ProcessEnv): string | null {
  if (optionalSetting("DEMO_RESET", source) !== "yes") {
    return "npm run demo:reset empties every teammate's work. Set DEMO_RESET=yes in the settings file of a demo machine to allow it.";
  }
  const readsGmail = optionalSetting("MAIL_SERVICE", source) === "gmail";
  const readsDrive = optionalSetting("FILE_SERVICE", source) === "gdrive";
  if (readsGmail || readsDrive) {
    return "The teammates read Google here, and the reset only empties LMail and LDrive. Set MAIL_SERVICE and FILE_SERVICE back to the workshop's apps first.";
  }
  return null;
}

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function tablesIn(pool: Pool, schema: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
    [schema],
  );
  return rows.map((row) => row.name);
}

// The tables in an order where each comes after every table it refers to.
async function parentsFirst(pool: Pool, schema: string, tables: string[]): Promise<string[]> {
  const { rows: links } = await pool.query<{ child: string; parent: string }>(
    `SELECT child.relname AS child, parent.relname AS parent FROM pg_constraint link
       JOIN pg_class child ON child.oid = link.conrelid
       JOIN pg_class parent ON parent.oid = link.confrelid
       JOIN pg_namespace space ON space.oid = child.relnamespace
      WHERE link.contype = 'f' AND space.nspname = $1 AND child.relname <> parent.relname`,
    [schema],
  );
  const ordered: string[] = [];
  const visit = (table: string, seen: Set<string>) => {
    if (ordered.includes(table) || seen.has(table)) return;
    seen.add(table);
    for (const link of links.filter((each) => each.child === table)) visit(link.parent, seen);
    ordered.push(table);
  };
  for (const table of tables) visit(table, new Set());
  return ordered.filter((table) => tables.includes(table));
}

async function copySeedRows(client: PoolClient, from: string, into: string, table: string) {
  const { rows } = await client.query<{ name: string }>(
    "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'NEVER' ORDER BY ordinal_position",
    [from, table],
  );
  const columns = rows.map((column) => quoted(column.name)).join(", ");
  const source = `${quoted(from)}.${quoted(table)}`;
  await client.query(`INSERT INTO ${quoted(into)}.${quoted(table)} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM ${source}`);
}

// Empties every table but the kept ones, then copies the seed rows back. The seed rows come from
// the app's own migrations, run into a scratch schema, so they are exactly what a new install has.
// Sequences carry on, so an id handed out before the reset is never handed out again.
export async function resetDatabase(pool: Pool, address: string, keep: string[], folder?: string): Promise<string[]> {
  const { rows } = await pool.query<{ schema: string }>("SELECT current_schema() AS schema");
  const target = rows[0].schema;
  const emptied = (await tablesIn(pool, target)).filter((table) => !keep.includes(table)).sort();
  const scratch = `seed_${randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA ${scratch}`);
  const seedPool = createPool(address, scratch);
  try {
    await migrate(seedPool, folder);
    const seeded = (await tablesIn(pool, scratch)).filter((table) => emptied.includes(table));
    const order = await parentsFirst(pool, scratch, seeded);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // No CASCADE: a kept table that refers to an emptied one stops the reset instead of losing rows.
      const names = emptied.map((table) => `${quoted(target)}.${quoted(table)}`);
      if (names.length) await client.query(`TRUNCATE ${names.join(", ")}`);
      for (const table of order) await copySeedRows(client, scratch, target, table);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await seedPool.end();
    await pool.query(`DROP SCHEMA ${scratch} CASCADE`);
  }
  return emptied;
}

// Deletes every object under a prefix.
export async function emptyPrefix(storage: S3Client, bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await storage.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const keys = (page.Contents ?? []).map((item) => ({ Key: item.Key! }));
    if (!keys.length) return deleted;
    await storage.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    deleted += keys.length;
  }
}

// Each teammate's row stays, because its read positions point at it. Every setting a person
// changed goes back to its default, and the eval and attack teammates go.
async function teammatesAsNew(pool: Pool) {
  await pool.query("DELETE FROM cursors WHERE (company, teammate) IN (SELECT company, id FROM teammates WHERE harness)");
  await pool.query("DELETE FROM teammates WHERE harness");
  const { rows } = await pool.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'teammates' AND column_default IS NOT NULL`,
  );
  if (rows.length) await pool.query(`UPDATE teammates SET ${rows.map((column) => `${quoted(column.name)} = DEFAULT`).join(", ")}`);
  for (const teammate of TEAMMATES) {
    await pool.query("UPDATE teammates SET name = $1, daily_budget_usd = $2 WHERE kind = $3", [teammate.name, teammate.defaults.dailyBudgetUsd, teammate.kind]);
  }
}

// Mission Control: every teammate's work goes, and each teammate starts again as a new install has it.
export async function resetMissionControl(pool: Pool, address: string): Promise<string[]> {
  const emptied = await resetDatabase(pool, address, KEEP.missionControl);
  await teammatesAsNew(pool);
  await ensureTeammates(pool);
  await ensureStandingSchedules(pool);
  return emptied;
}

const SETTINGS: Setting[] = [
  "DATABASE_URL", "LMAIL_DATABASE_URL", "LDRIVE_DATABASE_URL", "QUIRKBOOKS_DATABASE_URL",
  "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "APP_URL", ...SEND_SETTINGS,
];

type App = { name: string; address: Setting; keep: string[]; folder?: string };
const APPS: App[] = [
  { name: "Mission Control", address: "DATABASE_URL", keep: KEEP.missionControl },
  { name: "LMail", address: "LMAIL_DATABASE_URL", keep: KEEP.lmail, folder: path.join(ROOT, "apps/lmail/migrations") },
  { name: "LDrive", address: "LDRIVE_DATABASE_URL", keep: KEEP.ldrive, folder: path.join(ROOT, "apps/ldrive/migrations") },
  { name: "QuirkBooks", address: "QUIRKBOOKS_DATABASE_URL", keep: KEEP.quirkbooks, folder: path.join(ROOT, "apps/quirkbooks/migrations") },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const refused = refusal(process.env);
  if (refused) {
    console.error(refused);
    process.exit(1);
  }
  requireSettings(SETTINGS);
  // Both ways the morning arrives must answer before anything is emptied, so a stopped app
  // never leaves a half-reset demo.
  await invoiceFolderId();
  const smtp = smtpTransport();
  await smtp.verify();
  smtp.close();

  for (const app of APPS) {
    const address = setting(app.address);
    const pool = createPool(address);
    try {
      const emptied = app.folder ? await resetDatabase(pool, address, app.keep, app.folder) : await resetMissionControl(pool, address);
      console.log(`${app.name}: emptied ${emptied.length} tables and put the seed rows back.`);
    } finally {
      await pool.end();
    }
  }
  const storage = createS3();
  let memory = 0;
  for (const company of Object.keys(COMPANIES)) memory += await emptyPrefix(storage, MEMORY_BUCKET, `${company}/`);
  const files = await emptyPrefix(storage, DRIVE_BUCKET, "");
  console.log(`Memory: deleted ${memory} files. LDrive: deleted ${files} files.`);

  await sendCases(casesNamed(MORNING));
  console.log(`\nThe morning's ${MORNING.length} invoices are on their way. Open ${setting("APP_URL")} and watch Needs you.`);
}
