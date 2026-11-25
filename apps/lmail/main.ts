import express, { type Request } from "express";
import { z } from "zod";
import { createAuth, type Person } from "../../src/server/auth";
import { createPool, migrate } from "../../src/server/db";
import { optionalSetting, requireSettings, setting } from "../../src/server/env";
import { COMPANIES } from "../../src/server/people";
import { apiKeys } from "../shared/api-keys";
import { createApp, HttpError, listen, servePage } from "../shared/server";
import { WebhookSender, requireHookAddress } from "../shared/webhooks";
import { startSmtp } from "./smtp";
import { MailStore, normalize } from "./store";

// LMail: mail for Bramble Studio and its vendors. People read and write mail on its web page;
// programs use its API with a key, the way they would use Gmail's.

requireSettings(["LMAIL_URL", "LMAIL_PORT", "LMAIL_SMTP_PORT", "LMAIL_DATABASE_URL", "LMAIL_API_KEY", "LMAIL_WEBHOOK_SECRET", "LMAIL_CLIENT_SECRET", "OIDC_ISSUER", "HOOKS_URL"]);

const MIGRATIONS = new URL("./migrations", import.meta.url).pathname;

// Mission Control works the shared accounts payable mailbox and nothing else.
const CLIENTS = [{ name: "mission-control", scopes: ["mail.read", "mail.send"], key: setting("LMAIL_API_KEY"), mailboxes: ["ap@bramble.example"] }];

const pool = createPool(setting("LMAIL_DATABASE_URL"));
await migrate(pool, MIGRATIONS);
const webhooks = new WebhookSender(pool, setting("LMAIL_WEBHOOK_SECRET"));
const store = new MailStore(pool, webhooks, optionalSetting("LMAIL_RELAY_URL"));
const requireScope = apiKeys(CLIENTS);

// A program may touch only the mailboxes its key was given.
function programMailbox(request: Request, address: string): string {
  const client = CLIENTS.find((entry) => entry.name === request.client?.name);
  const mailbox = normalize(address);
  if (!client?.mailboxes.includes(mailbox)) throw new HttpError(403, `This key cannot use ${mailbox}.`);
  return mailbox;
}

// A person opens their own mailbox and their company's shared ones. An admin, who runs the
// workshop, opens every mailbox, vendors' included, to send invoices and read replies.
function canOpen(person: Person, address: string): boolean {
  if (person.roles.includes("admin")) return true;
  const domain = COMPANIES[person.company]?.domain;
  return normalize(address) === normalize(person.email) || normalize(address) === `ap@${domain}`;
}

const Attachment = z.object({ filename: z.string().min(1), contentType: z.string(), base64: z.string() });

const Send = z.object({
  to: z.array(z.email()).min(1).max(20),
  subject: z.string().max(300),
  text: z.string().max(100_000),
  inReplyTo: z.string().optional(),
  attachments: z.array(Attachment).max(10).optional(),
});

function outgoing(body: unknown) {
  const mail = Send.parse(body);
  return { ...mail, attachments: mail.attachments?.map((item) => ({ filename: item.filename, contentType: item.contentType, content: Buffer.from(item.base64, "base64") })) };
}

const app = createApp("lmail", { postgres: () => pool.query("SELECT 1") });
app.use(express.json({ limit: "20mb" }));

// ---------- The API, for programs ----------

app.get("/api/v1/mailboxes/:address/history", requireScope("mail.read"), async (request, response) => {
  const start = String(request.query.startHistoryId ?? "0");
  if (!/^\d+$/.test(start)) throw new HttpError(400, "startHistoryId is a whole number.");
  response.json(await store.history(programMailbox(request, String(request.params.address)), start));
});

app.get("/api/v1/messages/:id", requireScope("mail.read"), async (request, response) => {
  const message = await store.get(String(request.params.id));
  if (!message) throw new HttpError(404, "No such message.");
  programMailbox(request, message.mailbox);
  response.json(message);
});

app.get("/api/v1/messages/:id/attachments/:attachmentId", requireScope("mail.read"), async (request, response) => {
  const message = await store.get(String(request.params.id));
  if (!message) throw new HttpError(404, "No such message.");
  programMailbox(request, message.mailbox);
  const attachment = await store.attachment(message.id, String(request.params.attachmentId));
  if (!attachment) throw new HttpError(404, "No such attachment.");
  response.type(attachment.content_type).send(attachment.content);
});

app.post("/api/v1/mailboxes/:address/send", requireScope("mail.send"), async (request, response) => {
  const key = request.header("Idempotency-Key");
  if (!key) throw new HttpError(400, "Send with an Idempotency-Key header, so a retry never sends twice.");
  const result = await store.send(programMailbox(request, String(request.params.address)), outgoing(request.body), key);
  response.status(result.repeated ? 200 : 201).json(result);
});

app.post("/api/v1/mailboxes/:address/watch", requireScope("mail.read"), async (request, response) => {
  const { url } = z.object({ url: z.url() }).parse(request.body);
  const address = requireHookAddress(url, setting("HOOKS_URL"));
  response.json(await store.watch(programMailbox(request, String(request.params.address)), address, request.client!.name));
});

// ---------- The web page, for people ----------

const { router, requirePerson } = await createAuth({
  pool,
  issuer: setting("OIDC_ISSUER"),
  clientId: "lmail",
  clientSecret: setting("LMAIL_CLIENT_SECRET"),
  appUrl: setting("LMAIL_URL"),
  mountPath: "/auth",
  cookieName: "lmail_session",
});
app.use("/auth", router);

function openable(request: Request, address: string): string {
  if (!canOpen(request.person!, address)) throw new HttpError(403, "You cannot open this mailbox.");
  return normalize(address);
}

app.get("/api/me", requirePerson, (request, response) => {
  response.json(request.person);
});

app.get("/api/mailboxes", requirePerson, async (request, response) => {
  response.json((await store.mailboxes()).filter((box) => canOpen(request.person!, box.address)));
});

app.get("/api/mailboxes/:address/messages", requirePerson, async (request, response) => {
  const folder = request.query.folder === "sent" ? "sent" : "inbox";
  response.json(await store.list(openable(request, String(request.params.address)), folder));
});

app.get("/api/messages/:id", requirePerson, async (request, response) => {
  const message = await store.get(String(request.params.id));
  if (!message) throw new HttpError(404, "No such message.");
  openable(request, message.mailbox);
  await store.markRead(message.id);
  response.json({ ...message, unread: false });
});

app.get("/api/messages/:id/attachments/:attachmentId", requirePerson, async (request, response) => {
  const message = await store.get(String(request.params.id));
  if (!message) throw new HttpError(404, "No such message.");
  openable(request, message.mailbox);
  const attachment = await store.attachment(message.id, String(request.params.attachmentId));
  if (!attachment) throw new HttpError(404, "No such attachment.");
  response.attachment(attachment.filename).type(attachment.content_type).send(attachment.content);
});

app.post("/api/mailboxes/:address/send", requirePerson, async (request, response) => {
  response.status(201).json(await store.send(openable(request, String(request.params.address)), outgoing(request.body)));
});

servePage(app, "lmail");
webhooks.start();
startSmtp(store, Number(setting("LMAIL_SMTP_PORT")));
listen(app, "LMail", Number(setting("LMAIL_PORT")));
