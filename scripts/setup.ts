// npm run setup
//
// Starts the platform (infra/docker-compose.yml) and configures it, so Mission Control signs
// people in through Keycloak and asks OpenFGA what each may do. Safe to run again: each step
// looks first and changes only what differs.
//
// Secrets are generated into .env the first time and never printed. Sign in as a seeded person
// with the password in your own .env (SEED_USER_PASSWORD).

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialsMethod, OpenFgaClient } from "@openfga/sdk";
import { parse } from "dotenv";
import { COMPANIES, ROLES, SEED_PEOPLE, type Role, type SeedPerson } from "../src/server/people";
import { modelJson } from "./fga-model";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
const langfuseEnvFile = path.join(root, "langfuse", ".env");
const REALM = "teammates";
const CLIENT_ID = "mission-control";
const AUDIENCE = "mission-control-api";
const KEYCLOAK = "http://localhost:8190";
const FGA = "http://localhost:8290";
const FGA_STORE_NAME = "mission-control";
const APP_URL = "http://localhost:3333";

// The three apps the teammates work in, each its own service with its own database and sign-in.
const WORLD = [
  { id: "lmail", prefix: "LMAIL", name: "LMail", port: 8801 },
  { id: "ldrive", prefix: "LDRIVE", name: "LDrive", port: 8802 },
  { id: "quirkbooks", prefix: "QUIRKBOOKS", name: "QuirkBooks", port: 8803 },
] as const;

// ---------- .env: generate what is missing, keep what is there ----------

const secret = () => randomBytes(24).toString("base64url");
// Standard Webhooks secrets are "whsec_" and base64 of the key bytes.
const webhookSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

function setEnv(values: Record<string, string>, file = envFile) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  for (const [name, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at >= 0) lines[at] = `${name}=${value}`;
    else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, `${name}=${value}`);
  }
  writeFileSync(file, `${lines.join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
}

// Reads a settings file and returns a want() that keeps a value already there or makes a new one.
function settingsFile(file: string) {
  const current = existsSync(file) ? parse(readFileSync(file)) : {};
  const missing: Record<string, string> = {};
  const want = (name: string, make: () => string) => {
    if (!current[name]) missing[name] = make();
    return missing[name] ?? current[name];
  };
  const save = () => {
    if (Object.keys(missing).length === 0) return;
    setEnv(missing, file);
    console.log(`Written to ${path.relative(root, file)} (values not shown): ${Object.keys(missing).join(", ")}`);
  };
  return { current, missing, want, save };
}

// Langfuse runs from its own compose file (langfuse/) with its own settings file there, because
// its names (DATABASE_URL, POSTGRES_PASSWORD) are the same as the app's. The project and its
// keys are created on Langfuse's first start, and the app's settings get the same keys.
function ensureLangfuseSettings(): Record<string, string> {
  const langfuse = settingsFile(langfuseEnvFile);
  const postgres = langfuse.want("POSTGRES_PASSWORD", () => randomBytes(24).toString("hex"));
  langfuse.want("DATABASE_URL", () => `postgresql://postgres:${postgres}@postgres:5432/postgres`);
  for (const name of ["SALT", "NEXTAUTH_SECRET", "CLICKHOUSE_PASSWORD", "REDIS_AUTH"]) langfuse.want(name, () => randomBytes(24).toString("hex"));
  // Langfuse needs exactly 256 bits here, written as 64 hex characters.
  langfuse.want("ENCRYPTION_KEY", () => randomBytes(32).toString("hex"));
  const storage = langfuse.want("MINIO_ROOT_PASSWORD", () => randomBytes(24).toString("hex"));
  for (const use of ["EVENT_UPLOAD", "MEDIA_UPLOAD", "BATCH_EXPORT"]) langfuse.want(`LANGFUSE_S3_${use}_SECRET_ACCESS_KEY`, () => storage);
  langfuse.want("LANGFUSE_INIT_ORG_ID", () => "bramble");
  langfuse.want("LANGFUSE_INIT_ORG_NAME", () => "Bramble Studio");
  langfuse.want("LANGFUSE_INIT_PROJECT_ID", () => "mission-control");
  langfuse.want("LANGFUSE_INIT_PROJECT_NAME", () => "Mission Control");
  const publicKey = langfuse.want("LANGFUSE_INIT_PROJECT_PUBLIC_KEY", () => `pk-lf-${randomUUID()}`);
  const secretKey = langfuse.want("LANGFUSE_INIT_PROJECT_SECRET_KEY", () => `sk-lf-${randomUUID()}`);
  langfuse.want("LANGFUSE_INIT_USER_EMAIL", () => "admin@bramble.example");
  langfuse.want("LANGFUSE_INIT_USER_NAME", () => "Langfuse admin");
  langfuse.want("LANGFUSE_INIT_USER_PASSWORD", secret);
  langfuse.save();
  return { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: "http://localhost:3100" };
}

function ensureSettings(): Record<string, string> {
  const { current, missing, want, save } = settingsFile(envFile);
  for (const [name, value] of Object.entries(ensureLangfuseSettings())) want(name, () => value);
  for (const name of ["POSTGRES_PASSWORD", "KEYCLOAK_DB_PASSWORD", "OPENFGA_DB_PASSWORD", "TEAMMATES_DB_PASSWORD"]) want(name, secret);
  for (const name of ["KEYCLOAK_ADMIN_PASSWORD", "FGA_API_TOKEN", "OIDC_CLIENT_SECRET", "SEED_USER_PASSWORD"]) want(name, secret);
  want("S3_ACCESS_KEY_ID", () => `teammates-${randomBytes(6).toString("hex")}`);
  want("S3_SECRET_ACCESS_KEY", secret);
  const database = missing.TEAMMATES_DB_PASSWORD ?? current.TEAMMATES_DB_PASSWORD;
  want("DATABASE_URL", () => `postgresql://teammates:${database}@localhost:5452/teammates`);
  want("TEST_DATABASE_URL", () => `postgresql://teammates:${database}@localhost:5452/teammates_test`);
  // Addresses, not secrets: written once so every process reads the same ones.
  want("APP_URL", () => APP_URL);
  want("PORT", () => "8787");
  want("OIDC_ISSUER", () => `${KEYCLOAK}/realms/${REALM}`);
  want("OIDC_CLIENT_ID", () => CLIENT_ID);
  want("OIDC_AUDIENCE", () => AUDIENCE);
  want("FGA_API_URL", () => FGA);
  want("S3_ENDPOINT", () => "http://localhost:9100");
  want("S3_REGION", () => "us-east-1");
  want("GATEWAY_PORT", () => "8788");
  want("GATEWAY_URL", () => "http://localhost:8788");
  for (const name of ["GATEWAY_WORKER_TOKEN", "GATEWAY_DISPATCHER_TOKEN"]) want(name, secret);
  for (const app of WORLD) {
    const password = want(`${app.prefix}_DB_PASSWORD`, secret);
    want(`${app.prefix}_DATABASE_URL`, () => `postgresql://${app.id}:${password}@localhost:5452/${app.id}`);
    want(`${app.prefix}_URL`, () => `http://localhost:${app.port}`);
    want(`${app.prefix}_PORT`, () => String(app.port));
    want(`${app.prefix}_CLIENT_SECRET`, secret);
    want(`${app.prefix}_API_KEY`, secret);
  }
  want("LMAIL_SMTP_PORT", () => "2525");
  want("LMAIL_WEBHOOK_SECRET", webhookSecret);
  want("LDRIVE_WEBHOOK_SECRET", webhookSecret);
  want("LDRIVE_UPLOAD_KEY", secret);
  save();
  return { ...current, ...missing };
}

// ---------- Keycloak admin API ----------

let adminToken = "";

async function keycloak(method: string, route: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${KEYCLOAK}/admin/realms${route}`, {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new Error(`Keycloak ${method} ${route} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

async function keycloakJson<T>(route: string): Promise<T | null> {
  const response = await keycloak("GET", route);
  return response.status === 404 ? null : ((await response.json()) as T);
}

async function signInAsAdmin(password: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        adminToken = ((await response.json()) as { access_token: string }).access_token;
        return;
      }
      if (response.status === 401) throw new Error("Keycloak refused the admin password in .env. If you changed it, reset the volume.");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Keycloak refused")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Keycloak did not start within two minutes. Check: docker compose -f infra/docker-compose.yml logs keycloak");
}

async function setupRealm() {
  const settings = {
    realm: REALM,
    displayName: "Mission Control",
    enabled: true,
    // Each company is a Keycloak organization; its alias is the company id the app uses.
    organizationsEnabled: true,
    // No one signs themselves up: an administrator creates each account.
    registrationAllowed: false,
    resetPasswordAllowed: false,
    bruteForceProtected: true,
    failureFactor: 5,
    passwordPolicy: "length(12) and notUsername and notEmail",
    sslRequired: "external",
    // Short access tokens; the app refreshes them, so a disabled account stops within five minutes.
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 28800,
  };
  const existing = await keycloakJson(`/${REALM}`);
  await keycloak(existing ? "PUT" : "POST", existing ? `/${REALM}` : "", settings);
  console.log(`Realm ${REALM}: ${existing ? "updated" : "created"}`);
}

type UserProfile = { attributes: { name: string }[] } & Record<string, unknown>;

// An approver's limit is a user attribute only an admin can edit, so nobody raises their own.
async function setupLimitAttribute() {
  const profile = (await keycloakJson<UserProfile>(`/${REALM}/users/profile`))!;
  const limit = {
    name: "approval_limit",
    displayName: "Approval limit",
    permissions: { view: ["admin", "user"], edit: ["admin"] },
    validations: { pattern: { pattern: "^[0-9]{1,9}$", "error-message": "Use a whole amount, such as 5000." } },
    multivalued: false,
  };
  profile.attributes = [...profile.attributes.filter((attribute) => attribute.name !== "approval_limit"), limit];
  await keycloak("PUT", `/${REALM}/users/profile`, profile);
}

type Organization = { id: string; alias: string };

async function setupOrganizations(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const company of Object.values(COMPANIES)) {
    const search = `/${REALM}/organizations?search=${encodeURIComponent(company.name)}&exact=true`;
    const body = { name: company.name, alias: company.alias, enabled: true, domains: [{ name: company.domain, verified: true }] };
    let organization = ((await keycloakJson<Organization[]>(search)) ?? []).find((item) => item.alias === company.alias);
    if (organization) await keycloak("PUT", `/${REALM}/organizations/${organization.id}`, { ...body, id: organization.id });
    else {
      await keycloak("POST", `/${REALM}/organizations`, body);
      organization = ((await keycloakJson<Organization[]>(search)) ?? []).find((item) => item.alias === company.alias);
    }
    if (!organization) throw new Error(`Keycloak did not create the organization ${company.alias}.`);
    ids[company.alias] = organization.id;
  }
  console.log(`Organizations: ${Object.keys(ids).join(", ")}`);
  return ids;
}

type ClientScope = { id: string; name: string };
type Mapper = { id?: string; name: string; protocol: string; protocolMapper: string; config: Record<string, string> };

async function organizationScopeId(): Promise<string> {
  const scopes = (await keycloakJson<ClientScope[]>(`/${REALM}/client-scopes`))!;
  const existing = scopes.find((scope) => scope.name === "organization");
  if (existing) return existing.id;
  await keycloak("POST", `/${REALM}/client-scopes`, {
    name: "organization",
    protocol: "openid-connect",
    attributes: { "include.in.token.scope": "true" },
    protocolMappers: [
      {
        name: "organization",
        protocol: "openid-connect",
        protocolMapper: "oidc-organization-membership-mapper",
        config: { "claim.name": "organization", multivalued: "true", "access.token.claim": "true", "id.token.claim": "true" },
      },
    ],
  });
  return (await keycloakJson<ClientScope[]>(`/${REALM}/client-scopes`))!.find((scope) => scope.name === "organization")!.id;
}

type ClientSpec = { clientId: string; name: string; appUrl: string; callback: string; secret: string; audience?: string };

async function setupClient(spec: ClientSpec) {
  const { appUrl, clientId } = spec;
  const settings = {
    clientId,
    name: spec.name,
    protocol: "openid-connect",
    enabled: true,
    // Confidential: the secret stays on the server. The browser never holds a token.
    publicClient: false,
    clientAuthenticatorType: "client-secret",
    secret: spec.secret,
    standardFlowEnabled: true,
    // The password grant and the implicit flow are off: the only way in is Keycloak's sign-in page.
    directAccessGrantsEnabled: false,
    implicitFlowEnabled: false,
    serviceAccountsEnabled: false,
    webOrigins: [],
    redirectUris: [`${appUrl}${spec.callback}`],
    attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": `${appUrl}/` },
  };
  let [client] = (await keycloakJson<{ id: string }[]>(`/${REALM}/clients?clientId=${clientId}`))!;
  if (client) await keycloak("PUT", `/${REALM}/clients/${client.id}`, { ...settings, id: client.id });
  else {
    await keycloak("POST", `/${REALM}/clients`, settings);
    [client] = (await keycloakJson<{ id: string }[]>(`/${REALM}/clients?clientId=${clientId}`))!;
  }
  const audience: Mapper[] = spec.audience
    ? [{
      // Tokens for this app name it as their audience; the server refuses any other token.
      name: `audience ${spec.audience}`,
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      config: { "included.custom.audience": spec.audience, "access.token.claim": "true", "id.token.claim": "false" },
    }]
    : [];
  const mappers: Mapper[] = [
    ...audience,
    {
      name: "approval_limit",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      config: {
        "user.attribute": "approval_limit",
        "claim.name": "approval_limit",
        "jsonType.label": "long",
        "access.token.claim": "true",
        "id.token.claim": "true",
        "userinfo.token.claim": "true",
      },
    },
  ];
  const existing = (await keycloakJson<Mapper[]>(`/${REALM}/clients/${client.id}/protocol-mappers/models`)) ?? [];
  for (const mapper of mappers) {
    const found = existing.find((item) => item.name === mapper.name);
    if (found) await keycloak("PUT", `/${REALM}/clients/${client.id}/protocol-mappers/models/${found.id}`, { ...mapper, id: found.id });
    else await keycloak("POST", `/${REALM}/clients/${client.id}/protocol-mappers/models`, mapper);
  }
  // The organization claim is always in the token, so the app never has to ask for it.
  await keycloak("PUT", `/${REALM}/clients/${client.id}/default-client-scopes/${await organizationScopeId()}`);
  console.log(`Client ${clientId}: redirect ${settings.redirectUris.join(", ")}`);
}

type RealmRole = { id: string; name: string };

async function setupRoles(): Promise<Record<Role, RealmRole>> {
  const descriptions: Record<Role, string> = {
    admin: "Configures teammates and decides any approval",
    approver: "Decides approvals up to their approval limit",
  };
  const roles = {} as Record<Role, RealmRole>;
  for (const name of ROLES) {
    const body = { name, description: descriptions[name] };
    const found = await keycloakJson<RealmRole>(`/${REALM}/roles/${name}`);
    if (found) await keycloak("PUT", `/${REALM}/roles/${name}`, body);
    else await keycloak("POST", `/${REALM}/roles`, body);
    roles[name] = (await keycloakJson<RealmRole>(`/${REALM}/roles/${name}`))!;
  }
  console.log(`Realm roles: ${ROLES.join(", ")}`);
  return roles;
}

async function setupPerson(person: SeedPerson, organizations: Record<string, string>, roles: Record<Role, RealmRole>, password: string) {
  const body = {
    username: person.email,
    email: person.email,
    emailVerified: true,
    firstName: person.firstName,
    lastName: person.lastName,
    enabled: true,
    attributes: person.approvalLimit === undefined ? {} : { approval_limit: [String(person.approvalLimit)] },
  };
  const search = `/${REALM}/users?email=${encodeURIComponent(person.email)}&exact=true`;
  let [user] = (await keycloakJson<{ id: string }[]>(search))!;
  if (user) await keycloak("PUT", `/${REALM}/users/${user.id}`, body);
  else {
    await keycloak("POST", `/${REALM}/users`, body);
    [user] = (await keycloakJson<{ id: string }[]>(search))!;
  }
  await keycloak("PUT", `/${REALM}/users/${user.id}/reset-password`, { type: "password", value: password, temporary: false });
  // One company per person: leave any other, join the right one.
  for (const [alias, organizationId] of Object.entries(organizations)) {
    const members = (await keycloakJson<{ id: string }[]>(`/${REALM}/organizations/${organizationId}/members?max=1000`)) ?? [];
    const isMember = members.some((member) => member.id === user.id);
    if (alias === person.company && !isMember) await keycloak("POST", `/${REALM}/organizations/${organizationId}/members`, user.id);
    if (alias !== person.company && isMember) await keycloak("DELETE", `/${REALM}/organizations/${organizationId}/members/${user.id}`);
  }
  // At most one role, the listed one. A person with none only views.
  const held = (await keycloakJson<RealmRole[]>(`/${REALM}/users/${user.id}/role-mappings/realm`)) ?? [];
  const wrong = held.filter((role) => (ROLES as readonly string[]).includes(role.name) && role.name !== person.role);
  if (wrong.length) await keycloak("DELETE", `/${REALM}/users/${user.id}/role-mappings/realm`, wrong);
  if (person.role && !held.some((role) => role.name === person.role)) await keycloak("POST", `/${REALM}/users/${user.id}/role-mappings/realm`, [roles[person.role]]);
}

// ---------- OpenFGA ----------

// The server returns the model with empty values filled in and keys in its own order. So two
// copies of the same rules are compared with those differences removed.
function canonical(value: unknown): string {
  const strip = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(strip);
    if (!item || typeof item !== "object") return item;
    const entries = Object.entries(item)
      .map(([name, inner]) => [name, strip(inner)] as const)
      // One empty object has a meaning and stays: "this": {} means "assigned directly".
      .filter(([key, inner]) => {
        if (inner === undefined || inner === null || inner === "") return false;
        if (key === "this" || typeof inner !== "object") return true;
        return Array.isArray(inner) ? inner.length > 0 : Object.keys(inner).length > 0;
      })
      .sort(([first], [second]) => first.localeCompare(second));
    return Object.fromEntries(entries);
  };
  return JSON.stringify(strip({ value }));
}

async function setupPermissions(apiToken: string) {
  const credentials = { method: CredentialsMethod.ApiToken, config: { token: apiToken } } as const;
  const admin = new OpenFgaClient({ apiUrl: FGA, credentials });
  const { stores } = await admin.listStores();
  const storeId = stores.find((store) => store.name === FGA_STORE_NAME)?.id ?? (await admin.createStore({ name: FGA_STORE_NAME })).id;
  const store = new OpenFgaClient({ apiUrl: FGA, storeId, credentials });
  const wanted = modelJson();
  const latest = await store.readLatestAuthorizationModel().catch(() => undefined);
  const same =
    latest?.authorization_model &&
    canonical(latest.authorization_model.type_definitions) === canonical(wanted.type_definitions) &&
    canonical(latest.authorization_model.conditions) === canonical(wanted.conditions);
  const modelId = same ? latest!.authorization_model!.id : (await store.writeAuthorizationModel(wanted)).authorization_model_id;
  setEnv({ FGA_STORE_ID: storeId, FGA_MODEL_ID: modelId });
  console.log(`OpenFGA store ${FGA_STORE_NAME}: model ${same ? "unchanged" : "written"}`);
}

async function main() {
  const values = ensureSettings();
  console.log("Starting Postgres, Keycloak, OpenFGA and MinIO (the first start takes a minute)...");
  execFileSync("docker", ["compose", "--env-file", envFile, "-f", path.join(root, "infra/docker-compose.yml"), "up", "-d", "--wait"], { stdio: "inherit" });
  // The databases script is idempotent: it creates what is missing and sets every password from .env.
  execFileSync("docker", ["compose", "--env-file", envFile, "-f", path.join(root, "infra/docker-compose.yml"), "exec", "-T", "postgres", "bash", "/docker-entrypoint-initdb.d/01-databases.sh"], { stdio: "inherit" });
  await signInAsAdmin(values.KEYCLOAK_ADMIN_PASSWORD);
  await setupRealm();
  await setupLimitAttribute();
  const organizations = await setupOrganizations();
  await setupClient({ clientId: CLIENT_ID, name: "Mission Control", appUrl: values.APP_URL, callback: "/api/auth/callback", secret: values.OIDC_CLIENT_SECRET, audience: AUDIENCE });
  for (const app of WORLD) {
    await setupClient({ clientId: app.id, name: app.name, appUrl: values[`${app.prefix}_URL`], callback: "/auth/callback", secret: values[`${app.prefix}_CLIENT_SECRET`] });
  }
  const roles = await setupRoles();
  for (const person of SEED_PEOPLE) await setupPerson(person, organizations, roles, values.SEED_USER_PASSWORD);
  console.log(`People: ${SEED_PEOPLE.map((person) => `${person.email} (${person.role ?? "viewer"})`).join(", ")}`);
  await setupPermissions(values.FGA_API_TOKEN);
  if (!values.OPENROUTER_API_KEY) console.log("\nOne setting is yours to add: OPENROUTER_API_KEY in .env, from openrouter.ai/settings/keys.");
  console.log(`\nDone. Sign in as a person above; the password is SEED_USER_PASSWORD in your .env.`);
  console.log(`Keycloak admin: ${KEYCLOAK}/admin/master/console/#/${REALM} (user admin, password KEYCLOAK_ADMIN_PASSWORD in .env).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
