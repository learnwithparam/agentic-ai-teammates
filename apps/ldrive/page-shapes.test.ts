import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import type { Pool } from "pg";
import * as page from "../../src/client/ldrive/api";
import { testDatabase } from "../../src/server/test-database";
import { WebhookSender } from "../shared/webhooks";
import { DriveStore } from "./store";

// The LDrive page reads the store's answers through its own schemas. Listing reads only the
// database, so the file row is written directly and no bucket is needed.

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const INVOICES = "6f1c2b1e-4a51-4f7e-9b0e-0d3c1a7e2f10";
let pool: Pool;
let close: () => Promise<void>;
let store: DriveStore;

before(async () => {
  ({ pool, close } = await testDatabase(migrations));
  store = new DriveStore(pool, new S3Client({ region: "auto" }), new WebhookSender(pool, randomBytes(24).toString("base64")));
});
after(() => close());

test("the page reads the folders and a folder's files", async () => {
  await pool.query(
    "INSERT INTO files (id, folder_id, name, content_type, size, sha256, object_key, uploaded_by) VALUES ($1, $2, 'HL-2.pdf', 'application/pdf', 2048, 'abc', 'k', 'ada@bramble.example')",
    [randomUUID(), INVOICES],
  );
  const folders = page.Folders.parse(await store.folders());
  assert.equal(folders.find((folder) => folder.id === INVOICES)?.files, 1);
  const files = page.Files.parse(await store.list(INVOICES));
  assert.equal(files[0].name, "HL-2.pdf");
});
