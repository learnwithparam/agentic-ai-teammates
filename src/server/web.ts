import { listen, servePage } from "../../apps/shared/server";
import { createAuth } from "./auth";
import { createPool, migrate } from "./db";
import { requireSettings, setting } from "./env";
import { recordMember } from "./members";
import { openFgaCheck } from "./permissions";
import { Memory } from "./memory";
import { createS3 } from "./s3";
import { chosenServices, googleHooks } from "./services";
import { createWebApp } from "./web-app";

// Mission Control's web process. Start it with npm run web. It serves the board, its API and
// the world apps' signed notices. It holds no model key and no world app key.

requireSettings([
  "APP_URL", "PORT", "DATABASE_URL", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_AUDIENCE",
  "FGA_API_URL", "FGA_API_TOKEN", "FGA_STORE_ID", "FGA_MODEL_ID", "LMAIL_WEBHOOK_SECRET", "LDRIVE_WEBHOOK_SECRET",
  "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
]);

const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);

const auth = await createAuth({
  pool,
  issuer: setting("OIDC_ISSUER"),
  clientId: setting("OIDC_CLIENT_ID"),
  clientSecret: setting("OIDC_CLIENT_SECRET"),
  appUrl: setting("APP_URL"),
  mountPath: "/api/auth",
  cookieName: "mission_control_session",
  audience: setting("OIDC_AUDIENCE"),
  onSignIn: (person) => recordMember(pool, person),
});

const memory = new Memory(createS3());
await memory.ready();
const app = createWebApp({
  pool,
  memory,
  auth,
  check: openFgaCheck({
    apiUrl: setting("FGA_API_URL"),
    apiToken: setting("FGA_API_TOKEN"),
    storeId: setting("FGA_STORE_ID"),
    modelId: setting("FGA_MODEL_ID"),
  }),
  hookSecrets: { lmail: setting("LMAIL_WEBHOOK_SECRET"), ldrive: setting("LDRIVE_WEBHOOK_SECRET") },
  googleHooks: googleHooks(chosenServices()),
});
servePage(app, "mission-control");

const server = listen(app, "Mission Control", Number(setting("PORT")));
server.on("close", () => void pool.end());
