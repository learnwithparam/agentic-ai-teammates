import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { testDatabase } from "../../src/server/test-database";
import { WebhookSender } from "../shared/webhooks";
import { MailStore } from "./store";

// A client that watches a mailbox again from a new address must stop hearing at the old one.
// Before this, a move to a new port left the old watch in place. A real invoice notice then went
// to the old port and died there.

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const MAILBOX = "ap@bramble.example";
let pool: Pool;
let close: () => Promise<void>;
let store: MailStore;

before(async () => {
  ({ pool, close } = await testDatabase(migrations));
  store = new MailStore(pool, new WebhookSender(pool, `whsec_${randomBytes(32).toString("base64")}`));
});
after(() => close());

async function noticeAddresses(): Promise<string[]> {
  const { rows } = await pool.query<{ url: string }>("SELECT url FROM webhook_deliveries ORDER BY url");
  return rows.map((row) => row.url);
}

test("watching again from a new address moves the watch, so new mail goes only there", async () => {
  await store.watch(MAILBOX, "http://localhost:8787/hooks/lmail/bramble", "mission-control");
  await store.watch(MAILBOX, "http://localhost:8790/hooks/lmail/bramble", "mission-control");
  await store.watch(MAILBOX, "http://localhost:8790/hooks/lmail/bramble", "audit-tool");

  await pool.query("DELETE FROM webhook_deliveries");
  await store.deliver(
    { messageId: "<move@test>", fromAddress: "billing@northwind.example", to: [MAILBOX], subject: "Invoice", text: "Attached.", attachments: [] },
    [MAILBOX],
  );

  assert.deepEqual(await noticeAddresses(), [
    "http://localhost:8790/hooks/lmail/bramble",
    "http://localhost:8790/hooks/lmail/bramble",
  ]);
  const { rows } = await pool.query("SELECT client FROM watches WHERE mailbox = $1 ORDER BY client", [MAILBOX]);
  assert.deepEqual(rows.map((row) => row.client), ["audit-tool", "mission-control"]);
});
