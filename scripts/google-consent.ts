import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setting } from "../src/server/env";
import { GOOGLE_TOKEN_URL } from "../src/server/adapters/google";
import { LOOPBACK } from "../apps/shared/server";
import { setEnv } from "./env-file";

// npm run google:consent. You sign in to the Google account the accounts team reads, and allow
// the teammates to read its mail and Drive and to send replies. The refresh token Google gives
// back goes into .env as GOOGLE_REFRESH_TOKEN and is never printed.
//
// It needs a Desktop app OAuth client, whose id and secret are already in .env. Google sends
// the browser back to a port on this machine, which is how an installed app signs in.

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive.readonly",
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientId = setting("GOOGLE_CLIENT_ID");
const clientSecret = setting("GOOGLE_CLIENT_SECRET");
const verifier = randomBytes(32).toString("base64url");
const state = randomBytes(16).toString("base64url");

const server = createServer();
server.listen(0, LOOPBACK);
await new Promise((resolve) => server.once("listening", resolve));
const redirectUri = `http://${LOOPBACK}:${(server.address() as AddressInfo).port}/`;

const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
consent.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: SCOPES.join(" "),
  // Offline access with a fresh prompt is what makes Google return a refresh token.
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
}).toString();
console.log(`Open this address and allow access:\n\n${consent.href}\n`);

const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (request, response) => {
    const answer = new URL(request.url ?? "/", redirectUri).searchParams;
    if (answer.get("state") !== state) {
      response.writeHead(400).end("This answer is not for this sign-in.");
      return;
    }
    const given = answer.get("code");
    response.writeHead(given ? 200 : 400, { "Content-Type": "text/plain" }).end(given ? "Done. You can close this tab." : "Access was not allowed.");
    if (given) resolve(given);
    else reject(new Error(`Google said: ${answer.get("error") ?? "no code"}.`));
  });
});
server.close();

const response = await fetch(GOOGLE_TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }),
});
const tokens = (await response.json()) as { refresh_token?: string; error_description?: string };
if (!response.ok || !tokens.refresh_token) throw new Error(`Google gave no refresh token: ${tokens.error_description ?? response.status}.`);
setEnv({ GOOGLE_REFRESH_TOKEN: tokens.refresh_token }, path.join(root, ".env"));
console.log("Written to .env (value not shown): GOOGLE_REFRESH_TOKEN");
