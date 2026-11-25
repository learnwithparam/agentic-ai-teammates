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
  APP_URL: "The address people open, such as http://localhost:3333. npm run setup writes it.",
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

// Call once when a process starts, with every setting it will read. It then fails at startup
// with the whole list, not on its first request.
export function requireSettings(names: Setting[], source: NodeJS.ProcessEnv = process.env): void {
  const missing = names.filter((name) => !source[name]);
  if (missing.length > 0) throw new MissingSettings(missing);
}
