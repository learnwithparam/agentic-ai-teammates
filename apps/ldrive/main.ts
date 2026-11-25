import express, { type Request } from "express";
import { z } from "zod";
import { createAuth } from "../../src/server/auth";
import { createPool, migrate } from "../../src/server/db";
import { requireSettings, setting } from "../../src/server/env";
import { createS3, ensureBucket } from "../../src/server/s3";
import { apiKeys } from "../shared/api-keys";
import { createApp, HttpError, listen, servePage } from "../shared/server";
import { requireHookAddress, WebhookSender } from "../shared/webhooks";
import { BUCKET, DriveStore } from "./store";

// LDrive: Bramble Studio's shared folders. People drop files on its web page; programs read the
// change log with a key and hear about changes on a channel, the way they would with Google Drive.

requireSettings([
  "LDRIVE_URL", "LDRIVE_PORT", "LDRIVE_DATABASE_URL", "LDRIVE_API_KEY", "LDRIVE_UPLOAD_KEY", "LDRIVE_WEBHOOK_SECRET",
  "LDRIVE_CLIENT_SECRET", "OIDC_ISSUER", "HOOKS_URL", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
]);

const MIGRATIONS = new URL("./migrations", import.meta.url).pathname;

// Mission Control only reads. The workshop's upload script only writes.
const CLIENTS = [
  { name: "mission-control", scopes: ["drive.read"], key: setting("LDRIVE_API_KEY") },
  { name: "upload-script", scopes: ["drive.write"], key: setting("LDRIVE_UPLOAD_KEY") },
];

const pool = createPool(setting("LDRIVE_DATABASE_URL"));
await migrate(pool, MIGRATIONS);
const storage = createS3();
await ensureBucket(storage, BUCKET);
const webhooks = new WebhookSender(pool, setting("LDRIVE_WEBHOOK_SECRET"));
const store = new DriveStore(pool, storage, webhooks);
const requireScope = apiKeys(CLIENTS);

const raw = express.raw({ type: () => true, limit: "16mb" });

// A file name, with no folder part.
const FileName = z.string().min(1).max(200).regex(/^[^/\\]+$/);

function uploadName(request: Request): string {
  return FileName.parse(request.query.name);
}

const app = createApp("ldrive", { postgres: () => pool.query("SELECT 1"), storage: () => ensureBucket(storage, BUCKET) });

// ---------- The API, for programs ----------

app.get("/api/v1/changes/startPageToken", requireScope("drive.read"), async (_request, response) => {
  response.json({ startPageToken: await store.startPageToken() });
});

app.get("/api/v1/changes", requireScope("drive.read"), async (request, response) => {
  const pageToken = String(request.query.pageToken ?? "");
  if (!/^\d+$/.test(pageToken)) throw new HttpError(400, "pageToken is a whole number from startPageToken or an earlier page.");
  response.json(await store.changes(pageToken));
});

app.post("/api/v1/changes/watch", requireScope("drive.read"), express.json(), async (request, response) => {
  const Channel = z.object({ address: z.url(), token: z.string().min(16).max(256) });
  const { address, token } = Channel.parse(request.body);
  response.json(await store.watch(requireHookAddress(address, setting("HOOKS_URL")), token, request.client!.name));
});

app.post("/api/v1/channels/:id/stop", requireScope("drive.read"), async (request, response) => {
  await store.stopChannel(String(request.params.id), request.client!.name);
  response.status(204).end();
});

app.get("/api/v1/files/:id", requireScope("drive.read"), async (request, response) => {
  const file = await store.get(String(request.params.id));
  if (!file) throw new HttpError(404, "No such file.");
  response.json(file);
});

app.get("/api/v1/files/:id/content", requireScope("drive.read"), async (request, response) => {
  const { file, bytes } = await store.content(String(request.params.id));
  response.type(file.contentType).send(bytes);
});

app.get("/api/v1/folders", requireScope("drive.write"), async (_request, response) => {
  response.json(await store.folders());
});

app.post("/api/v1/folders/:id/files", requireScope("drive.write"), raw, async (request, response) => {
  const type = request.header("Content-Type") ?? "application/octet-stream";
  response.status(201).json(await store.upload(String(request.params.id), uploadName(request), type, request.body, request.client!.name));
});

// ---------- The web page, for people ----------

const { router, requirePerson } = await createAuth({
  pool,
  issuer: setting("OIDC_ISSUER"),
  clientId: "ldrive",
  clientSecret: setting("LDRIVE_CLIENT_SECRET"),
  appUrl: setting("LDRIVE_URL"),
  mountPath: "/auth",
  cookieName: "ldrive_session",
});
app.use("/auth", router);

app.get("/api/me", requirePerson, (request, response) => {
  response.json(request.person);
});

app.get("/api/folders", requirePerson, async (_request, response) => {
  response.json(await store.folders());
});

app.get("/api/folders/:id/files", requirePerson, async (request, response) => {
  response.json(await store.list(String(request.params.id)));
});

app.get("/api/files/:id/content", requirePerson, async (request, response) => {
  const { file, bytes } = await store.content(String(request.params.id));
  response.attachment(file.name).type(file.contentType).send(bytes);
});

app.post("/api/folders/:id/files", requirePerson, raw, async (request, response) => {
  const type = request.header("Content-Type") ?? "application/octet-stream";
  response.status(201).json(await store.upload(String(request.params.id), uploadName(request), type, request.body, request.person!.email));
});

// Only the person who uploaded a file, or an admin, may move it to the trash.
app.delete("/api/files/:id", requirePerson, async (request, response) => {
  const file = await store.get(String(request.params.id));
  if (!file) throw new HttpError(404, "No such file.");
  const person = request.person!;
  if (file.uploadedBy !== person.email && !person.roles.includes("admin")) throw new HttpError(403, "Only the uploader or an admin can remove this file.");
  await store.trash(file.id);
  response.status(204).end();
});

servePage(app, "ldrive");
webhooks.start();
listen(app, "LDrive", Number(setting("LDRIVE_PORT")));
