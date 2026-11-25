import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every setting the processes read, and the only file that reads process.env (check-repo.ts
// fails any other). A setting has no default secret and no stand-in: a process names the
// settings it needs when it starts, and a missing one stops it with where to get it.

// This file is in src/server during development and dist/server after a build. From both,
// ../../.env is the repository's .env. A container gets its settings from compose instead.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../.env"), quiet: true });

const SETTINGS = {
  APP_URL: "The address people open, such as http://localhost:8790. npm run setup writes it.",
  PORT: "The port the web process listens on. npm run setup writes it.",
  DATABASE_URL: "Mission Control's own Postgres. npm run setup writes it.",
  TEST_DATABASE_URL: "The tests' own Postgres database. npm run setup writes it.",
  OPENROUTER_API_KEY: "Your OpenRouter key, from openrouter.ai/settings/keys. Paste it into .env.",
  OIDC_ISSUER: "The Keycloak realm that signs people in. npm run setup writes it.",
  OIDC_CLIENT_ID: "Mission Control's Keycloak client. npm run setup writes it.",
  OIDC_CLIENT_SECRET: "Mission Control's Keycloak client secret. npm run setup writes it.",
  OIDC_AUDIENCE: "The audience every access token for this API carries. npm run setup writes it.",
  FGA_API_URL: "The OpenFGA server. npm run setup writes it.",
  FGA_API_TOKEN: "The OpenFGA preshared key. npm run setup writes it.",
  FGA_STORE_ID: "The OpenFGA store. npm run setup writes it.",
  FGA_MODEL_ID: "The pinned OpenFGA model. npm run setup writes it.",
  S3_ENDPOINT: "Where memory and LDrive files are stored: MinIO locally, R2 or S3 in production.",
  S3_REGION: "The S3 region. Use auto for R2 and us-east-1 for MinIO.",
  S3_ACCESS_KEY_ID: "The S3 access key. npm run setup writes MinIO's.",
  S3_SECRET_ACCESS_KEY: "The S3 secret key. npm run setup writes MinIO's.",
  LANGFUSE_PUBLIC_KEY: "The Langfuse project's public key. npm run setup writes the local project's.",
  LANGFUSE_SECRET_KEY: "The Langfuse project's secret key. npm run setup writes the local project's.",
  LANGFUSE_BASE_URL: "The Langfuse address: http://localhost:3100 locally, or your Langfuse Cloud region.",
  HOOKS_URL: "Where the world apps send their notices: Mission Control's web process. npm run setup writes it.",
  GATEWAY_URL: "Where the worker and dispatcher reach the gateway. npm run setup writes it.",
  GATEWAY_PORT: "The port the gateway listens on. npm run setup writes it.",
  GATEWAY_WORKER_TOKEN: "The worker's key to the gateway. npm run setup writes it.",
  GATEWAY_DISPATCHER_TOKEN: "The dispatcher's key to the gateway. npm run setup writes it.",
  LMAIL_URL: "LMail's API address. npm run setup writes it.",
  LMAIL_PORT: "The port LMail's web and API listen on. npm run setup writes it.",
  LMAIL_SMTP_PORT: "The port LMail receives mail on. npm run setup writes it.",
  LMAIL_DATABASE_URL: "LMail's own Postgres. npm run setup writes it.",
  LMAIL_API_KEY: "Mission Control's key to LMail. npm run setup writes it.",
  LMAIL_WEBHOOK_SECRET: "Signs LMail's notices to Mission Control. npm run setup writes it.",
  LMAIL_CLIENT_SECRET: "LMail's Keycloak client secret. npm run setup writes it.",
  LMAIL_RELAY_URL: "Optional. An SMTP relay, such as smtp://user:pass@host:587, to send outside LMail's own domains.",
  LDRIVE_URL: "LDrive's API address. npm run setup writes it.",
  LDRIVE_PORT: "The port LDrive listens on. npm run setup writes it.",
  LDRIVE_DATABASE_URL: "LDrive's own Postgres. npm run setup writes it.",
  LDRIVE_API_KEY: "Mission Control's read-only key to LDrive. npm run setup writes it.",
  LDRIVE_UPLOAD_KEY: "The workshop scripts' key for uploading to LDrive. npm run setup writes it.",
  LDRIVE_WEBHOOK_SECRET: "Signs LDrive's change notices. npm run setup writes it.",
  LDRIVE_CLIENT_SECRET: "LDrive's Keycloak client secret. npm run setup writes it.",
  QUIRKBOOKS_URL: "QuirkBooks' API address. npm run setup writes it.",
  QUIRKBOOKS_PORT: "The port QuirkBooks listens on. npm run setup writes it.",
  QUIRKBOOKS_DATABASE_URL: "QuirkBooks' own Postgres. npm run setup writes it.",
  QUIRKBOOKS_API_KEY: "Mission Control's key to QuirkBooks. npm run setup writes it.",
  QUIRKBOOKS_CLIENT_SECRET: "QuirkBooks' Keycloak client secret. npm run setup writes it.",
  NEWS_TARGET: "Optional. Where the news goes: site, Mission Control's own news page, or github. Leave it out for site.",
  GITHUB_TOKEN: "For NEWS_TARGET=github. A fine-grained GitHub token with Contents read and write on NEWS_REPO only.",
  NEWS_REPO: "For NEWS_TARGET=github. The repository the news cards publish to, as owner/name: your fork of this repo.",
  MAIL_SERVICE: "Optional. Where invoice mail arrives: lmail, the workshop's own mail, or gmail. Leave it out for lmail.",
  FILE_SERVICE: "Optional. Where invoice files arrive: ldrive, the workshop's own drive, or gdrive. Leave it out for ldrive.",
  GOOGLE_CLIENT_ID: "For gmail or gdrive. The OAuth client id from console.cloud.google.com, APIs and services, Credentials.",
  GOOGLE_CLIENT_SECRET: "For gmail or gdrive. That OAuth client's secret.",
  GOOGLE_REFRESH_TOKEN: "For gmail or gdrive. npm run google:consent prints it after you allow access.",
  GMAIL_ADDRESS: "For gmail. The Gmail address the accounts team reads, the one you allowed access as.",
  GMAIL_PUBSUB_TOPIC: "For gmail. The Pub/Sub topic Gmail publishes to, as projects/<project>/topics/<topic>.",
  GMAIL_PUSH_SERVICE_ACCOUNT: "For gmail. The service account the Pub/Sub push subscription signs its tokens as.",
  EXA_API_KEY: "Optional. An Exa key, from dashboard.exa.ai, turns on Exa as a news source.",
} as const;

export type Setting = keyof typeof SETTINGS;

export class MissingSettings extends Error {
  constructor(readonly missing: Setting[]) {
    super(`These settings are not set:\n${missing.map((name) => `  ${name}: ${SETTINGS[name]}`).join("\n")}`);
  }
}

export function setting(name: Setting, source: NodeJS.ProcessEnv = process.env): string {
  const value = source[name];
  if (!value) throw new MissingSettings([name]);
  return value;
}

// A setting that turns a feature on. Without it the feature is off and says so; nothing stands in.
export function optionalSetting(name: Setting, source: NodeJS.ProcessEnv = process.env): string | undefined {
  return source[name] || undefined;
}

// Call once when a process starts, with every setting it will read. It then fails at startup
// with the whole list, not on its first request.
export function requireSettings(names: Setting[], source: NodeJS.ProcessEnv = process.env): void {
  const missing = names.filter((name) => !source[name]);
  if (missing.length > 0) throw new MissingSettings(missing);
}
