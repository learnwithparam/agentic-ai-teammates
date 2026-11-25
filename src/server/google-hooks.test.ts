import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { Pool } from "pg";
import { handleErrors, LOOPBACK } from "../../apps/shared/server";
import { createHooksRouter, hookAddress } from "./hooks";
import { Inbox } from "./inbox";
import { testDatabase } from "./test-database";

// Gmail's notices come through Pub/Sub push, with a token Google signs for the hook's address.
// Here a key pair made in the test stands where Google's published keys stand, so the test can
// sign good tokens and bad ones. Drive's notices carry only the channel's secret token.

const HOOKS_URL = "https://teammates.example.com";
const PUSHER = "gmail-push@bramble-teammates.iam.gserviceaccount.com";
const MAILBOX = "accounts@bramble.example";

let pool: Pool;
let close: () => Promise<void>;
let server: ReturnType<express.Express["listen"]>;
let base: string;
let signingKey: CryptoKey;

before(async () => {
  ({ pool, close } = await testDatabase());
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "google-key", alg: "RS256" }] });
  const app = express();
  app.use(createHooksRouter({ pool, inbox: new Inbox(pool), secrets: { lmail: "whsec_unused", ldrive: "whsec_unused" }, google: { hooksUrl: HOOKS_URL, pushServiceAccount: PUSHER, mailbox: MAILBOX, keys } }));
  app.use(handleErrors);
  server = app.listen(0, LOOPBACK);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://${LOOPBACK}:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await close();
});
beforeEach(async () => {
  await pool.query("DELETE FROM inbox_events");
  await pool.query("DELETE FROM subscriptions");
  await pool.query("INSERT INTO teammates (company, id, kind, name) VALUES ('bramble', 'invoices', 'invoice', 'Invoices') ON CONFLICT DO NOTHING");
});

function googleToken(claims: { aud?: string; email?: string; email_verified?: boolean; iss?: string }) {
  return new SignJWT({ email: claims.email ?? PUSHER, email_verified: claims.email_verified ?? true })
    .setProtectedHeader({ alg: "RS256", kid: "google-key" })
    .setIssuer(claims.iss ?? "https://accounts.google.com")
    .setAudience(claims.aud ?? hookAddress(HOOKS_URL, "gmail", "bramble"))
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function push(token: string | null, notice = { emailAddress: MAILBOX, historyId: "4242" }) {
  const body = { message: { data: Buffer.from(JSON.stringify(notice)).toString("base64"), messageId: randomUUID() }, subscription: "projects/p/subscriptions/teammates" };
  return fetch(`${base}/hooks/gmail/bramble`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}

test("a Pub/Sub notice signed by Google for this hook and account is stored", async () => {
  const response = await push(await googleToken({}));
  assert.equal(response.status, 202);
  const { rows } = await pool.query("SELECT source, type, payload FROM inbox_events");
  assert.deepEqual(rows, [{ source: "gmail", type: "mail.received", payload: { emailAddress: MAILBOX, historyId: "4242" } }]);
});

test("a Pub/Sub notice is refused without a token, for another address, or from another account", async () => {
  assert.equal((await push(null)).status, 401);
  assert.equal((await push(await googleToken({ aud: hookAddress("https://elsewhere.example", "gmail", "bramble") }))).status, 401);
  assert.equal((await push(await googleToken({ email: "someone@evil.example" }))).status, 401);
  assert.equal((await push(await googleToken({ email_verified: false }))).status, 401);
  assert.equal((await push(await googleToken({ iss: "https://evil.example" }))).status, 401);
  assert.equal((await push(await googleToken({}), { emailAddress: "other@bramble.example", historyId: "1" })).status, 422);
  assert.equal((await pool.query("SELECT 1 FROM inbox_events")).rowCount, 0);
});

test("a Drive notice is stored only for the channel and token Mission Control holds", async () => {
  await pool.query("INSERT INTO subscriptions (source, address, channel_id, token, expires_at) VALUES ('gdrive:bramble', 'x', 'chan-1/res-1', 'right-token', now())");
  const notice = (channel: string, resource: string, token: string, state = "change") =>
    fetch(`${base}/hooks/gdrive/bramble`, { method: "POST", headers: { "X-Goog-Channel-ID": channel, "X-Goog-Resource-ID": resource, "X-Goog-Channel-Token": token, "X-Goog-Resource-State": state, "X-Goog-Message-Number": "7" } });
  assert.equal((await notice("chan-1", "res-1", "wrong-token")).status, 401);
  assert.equal((await notice("chan-1", "res-2", "right-token")).status, 401);
  assert.equal((await notice("chan-1", "res-1", "right-token", "sync")).status, 200);
  assert.equal((await notice("chan-1", "res-1", "right-token")).status, 202);
  const { rows } = await pool.query("SELECT source, source_id FROM inbox_events");
  assert.deepEqual(rows, [{ source: "gdrive", source_id: "chan-1/res-1:7" }]);
});
