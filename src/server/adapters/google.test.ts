import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import type { Pool } from "pg";
import { LOOPBACK } from "../../../apps/shared/server";
import { testDatabase } from "../test-database";
import { GoogleDrive } from "./gdrive";
import { Gmail, parseAddress, rawMessage } from "./gmail";
import { googleAccessToken } from "./google";
import { ServiceError } from "./http";

// The Gmail and Google Drive adapters against a server on this machine. It answers on the paths
// of Google's REST APIs, with the same JSON. Each test says what it answers.
// The adapters' own rules are what is tested: paging, mapping, and sending each reply once.

let pool: Pool;
let close: () => Promise<void>;
let google: ReturnType<express.Express["listen"]>;
let base: string;
// What the server answers, keyed by "METHOD path", and every request it was sent.
let answers: Record<string, (request: express.Request, response: express.Response) => void>;
let asked: string[];

const token = async () => "access-token";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

before(async () => {
  ({ pool, close } = await testDatabase());
  const app = express();
  app.use(express.json());
  app.use((request, response) => {
    const key = `${request.method} ${request.path}`;
    asked.push(`${key}${request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : ""}`);
    const answer = answers[key];
    if (!answer) response.status(404).json({ error: { message: `Nothing at ${key}.` } });
    else answer(request, response);
  });
  google = app.listen(0, LOOPBACK);
  await new Promise((resolve) => google.once("listening", resolve));
  base = `http://${LOOPBACK}:${(google.address() as AddressInfo).port}`;
});
after(async () => {
  google.close();
  await close();
});
beforeEach(async () => {
  answers = {};
  asked = [];
  await pool.query("DELETE FROM gmail_sends");
  await pool.query("DELETE FROM subscriptions");
});

const gmail = () => new Gmail(token, pool, "gmail:bramble", "projects/p/topics/invoices", `${base}/gmail/v1/users/me/`);
const drive = () => new GoogleDrive(token, pool, "gdrive:bramble", `${base}/drive/v3/`);

test("history follows every page and keeps only mail added to the inbox", async () => {
  answers["GET /gmail/v1/users/me/history"] = (request, response) => {
    if (!request.query.pageToken) {
      response.json({ historyId: "120", nextPageToken: "p2", history: [{ messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX", "UNREAD"] } }, { message: { id: "sent1", labelIds: ["SENT"] } }] }] });
    } else {
      response.json({ historyId: "130", history: [{ messagesAdded: [{ message: { id: "m2", labelIds: ["INBOX"] } }, { message: { id: "m1", labelIds: ["INBOX"] } }] }] });
    }
  };
  const page = await gmail().history("100");
  assert.deepEqual(page, { messageIds: ["m1", "m2"], historyId: "130" });
  assert.match(asked[0], /startHistoryId=100/);
  assert.match(asked[0], /labelId=INBOX/);
});

test("the first read starts where the first watch began, and refuses before any watch", async () => {
  answers["GET /gmail/v1/users/me/history"] = (_request, response) => response.json({ historyId: "77" });
  await assert.rejects(gmail().history("0"), (error: unknown) => error instanceof ServiceError && error.status === 409);
  await pool.query("INSERT INTO subscriptions (source, address, expires_at, start_cursor) VALUES ('gmail:bramble', 'x', now(), '70')");
  await gmail().history("0");
  assert.match(asked.at(-1)!, /startHistoryId=70/);
});

test("a message maps its sender, its text and its attachments by part id", async () => {
  answers["GET /gmail/v1/users/me/messages/m1"] = (_request, response) =>
    response.json({
      id: "m1",
      threadId: "t1",
      internalDate: String(Date.UTC(2026, 10, 20, 9, 30)),
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: '"Northwind Paper" <Billing@Northwind.example>' },
          { name: "Subject", value: "Invoice NW-2291" },
          { name: "Message-ID", value: "<nw-2291@northwind.example>" },
        ],
        parts: [
          { partId: "0", mimeType: "multipart/alternative", parts: [{ partId: "0.0", mimeType: "text/html", body: { data: b64("<p>Please find the invoice.</p><p>Thanks</p>") } }] },
          { partId: "1", mimeType: "application/pdf", filename: "NW-2291.pdf", body: { size: 2048, attachmentId: "ANGjdJ-changes-each-read" } },
        ],
      },
    });
  const message = await gmail().message("m1");
  assert.equal(message.from, "billing@northwind.example");
  assert.equal(message.fromName, "Northwind Paper");
  assert.equal(message.messageId, "<nw-2291@northwind.example>");
  assert.equal(message.text, "Please find the invoice.\nThanks");
  assert.equal(message.receivedAt, "2026-11-20T09:30:00.000Z");
  assert.deepEqual(message.attachments, [{ id: "1", filename: "NW-2291.pdf", contentType: "application/pdf", size: 2048 }]);

  answers["GET /gmail/v1/users/me/messages/m1/attachments/ANGjdJ-changes-each-read"] = (_request, response) => response.json({ data: Buffer.from("%PDF-1.7").toString("base64url") });
  const file = await gmail().attachment("m1", "1");
  assert.equal(file.contentType, "application/pdf");
  assert.equal(Buffer.from(file.bytes).toString(), "%PDF-1.7");
});

test("a reply is sent once per key, in the thread it answers", async () => {
  let sends = 0;
  answers["GET /gmail/v1/users/me/messages"] = (_request, response) => response.json({ messages: [{ id: "m1", threadId: "t1" }] });
  answers["POST /gmail/v1/users/me/messages/send"] = (request, response) => {
    sends += 1;
    assert.equal(request.body.threadId, "t1");
    response.json({ id: "sent-1" });
  };
  const reply = { to: "billing@northwind.example", subject: "Re: Invoice NW-2291", text: "Posted. Thank you.", inReplyTo: "<nw-2291@northwind.example>" };
  assert.deepEqual(await gmail().send(reply, "reply-nw-2291"), { id: "sent-1" });
  assert.deepEqual(await gmail().send(reply, "reply-nw-2291"), { id: "sent-1" });
  assert.equal(sends, 1);
});

test("a send whose answer never came is refused, never sent a second time", async () => {
  let sends = 0;
  answers["POST /gmail/v1/users/me/messages/send"] = (request) => {
    sends += 1;
    request.socket.destroy();
  };
  const reply = { to: "billing@northwind.example", subject: "Re: Invoice", text: "Posted.", inReplyTo: null };
  await assert.rejects(gmail().send(reply, "reply-lost"));
  await assert.rejects(gmail().send(reply, "reply-lost"), (error: unknown) => error instanceof ServiceError && error.status === 409);
  assert.equal(sends, 1);
});

test("a send Gmail refused may be tried again", async () => {
  let sends = 0;
  answers["POST /gmail/v1/users/me/messages/send"] = (_request, response) => {
    sends += 1;
    if (sends === 1) response.status(503).json({ error: { message: "Backend Error" } });
    else response.json({ id: "sent-2" });
  };
  const reply = { to: "billing@northwind.example", subject: "Re: Invoice", text: "Posted.", inReplyTo: null };
  await assert.rejects(gmail().send(reply, "reply-retry"), (error: unknown) => error instanceof ServiceError && error.status === 503);
  assert.deepEqual(await gmail().send(reply, "reply-retry"), { id: "sent-2" });
});

test("the raw reply carries the thread headers and encodes non-ASCII text", () => {
  const raw = Buffer.from(rawMessage({ to: "a@x.example", subject: "Re: Facture été", text: "Merci", inReplyTo: "<id@x>" }), "base64url").toString("utf8");
  assert.match(raw, /^To: a@x\.example\r\n/);
  assert.match(raw, /\r\nIn-Reply-To: <id@x>\r\nReferences: <id@x>\r\n/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.equal(Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString("utf8"), "Merci");
  assert.deepEqual(parseAddress("ap@bramble.example"), { name: null, address: "ap@bramble.example" });
});

test("Drive changes follow every page, skip removed and trashed files, and name the folder", async () => {
  answers["GET /drive/v3/changes"] = (request, response) => {
    const file = (id: string, extra = {}) => ({ id, name: `${id}.pdf`, mimeType: "application/pdf", size: "900", parents: ["folder-1"], lastModifyingUser: { emailAddress: "Mei@Bramble.example" }, ...extra });
    if (request.query.pageToken === "10") response.json({ nextPageToken: "11", changes: [{ file: file("a") }, { removed: true }, { file: file("b", { trashed: true }) }] });
    else response.json({ newStartPageToken: "12", changes: [{ file: file("c") }] });
  };
  answers["GET /drive/v3/files/folder-1"] = (_request, response) => response.json({ name: "Invoices" });
  const source = drive();
  const page = await source.changes("10");
  assert.equal(page.nextToken, "12");
  assert.deepEqual(page.added.map((file) => file.id), ["a", "c"]);
  assert.deepEqual(page.added[0], { id: "a", name: "a.pdf", folder: "Invoices", contentType: "application/pdf", size: 900, uploadedBy: "mei@bramble.example" });
  assert.equal(asked.filter((line) => line.startsWith("GET /drive/v3/files/folder-1")).length, 1, "The folder name is read once.");
});

test("a Drive channel is named by its id and resource id, and stopped by both", async () => {
  answers["GET /drive/v3/changes/startPageToken"] = (_request, response) => response.json({ startPageToken: "500" });
  answers["POST /drive/v3/changes/watch"] = (request, response) => {
    assert.equal(request.query.pageToken, "500");
    assert.deepEqual({ type: request.body.type, address: request.body.address, token: request.body.token }, { type: "web_hook", address: "https://t.example/hooks/gdrive/bramble", token: "secret" });
    response.json({ id: request.body.id, resourceId: "res-9", expiration: String(Date.UTC(2026, 11, 1)) });
  };
  let stopped: unknown;
  answers["POST /drive/v3/channels/stop"] = (request, response) => {
    stopped = request.body;
    response.status(204).end();
  };
  const channel = await drive().watch("https://t.example/hooks/gdrive/bramble", "secret");
  assert.match(channel.channelId, /^[0-9a-f-]{36}\/res-9$/);
  assert.equal(channel.expiration, "2026-12-01T00:00:00.000Z");
  await drive().stopWatch(channel.channelId);
  assert.deepEqual(stopped, { id: channel.channelId.split("/")[0], resourceId: "res-9" });
});

test("an access token is bought once and kept, and a refusal keeps Google's reason", async () => {
  let bought = 0;
  answers["POST /token"] = (_request, response) => {
    bought += 1;
    response.json({ access_token: `token-${randomUUID()}`, expires_in: 3599 });
  };
  const account = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };
  const access = googleAccessToken(account, `${base}/token`);
  assert.equal(await access(), await access());
  assert.equal(bought, 1);

  answers["POST /token"] = (_request, response) => response.status(400).json({ error: "invalid_grant", error_description: "Token has been expired or revoked." });
  await assert.rejects(googleAccessToken(account, `${base}/token`)(), /expired or revoked/);
});
