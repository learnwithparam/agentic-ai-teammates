import { listen } from "../../apps/shared/server";
import { LDrive } from "./adapters/ldrive";
import { LMail } from "./adapters/lmail";
import { QuirkBooks } from "./adapters/quirkbooks";
import { createPool, migrate } from "./db";
import { optionalSetting, requireSettings, setting } from "./env";
import { createGatewayApp } from "./gateway-app";
import { GitHubPublisher } from "./github";
import { createModelClient } from "./llm";
import { Memory } from "./memory";
import { COMPANIES } from "./people";
import { createS3 } from "./s3";
import { renewWatches } from "./subscriptions";
import { startTracing } from "./tracing";

// The gateway process. Start it with npm run gateway. It is the only process that holds the
// OpenRouter key and the world apps' keys.

requireSettings([
  "DATABASE_URL", "OPENROUTER_API_KEY", "GATEWAY_PORT", "GATEWAY_WORKER_TOKEN", "GATEWAY_DISPATCHER_TOKEN",
  "LMAIL_URL", "LMAIL_API_KEY", "LDRIVE_URL", "LDRIVE_API_KEY", "QUIRKBOOKS_URL", "QUIRKBOOKS_API_KEY",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "HOOKS_URL",
  "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
]);

const stopTracing = startTracing("gateway");
const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);

const mailboxes = new Map(Object.values(COMPANIES).map((company) => [company.alias, new LMail(setting("LMAIL_URL"), setting("LMAIL_API_KEY"), company.accountsMailbox)]));
const githubToken = optionalSetting("GITHUB_TOKEN");
const newsRepo = optionalSetting("NEWS_REPO");
if (!githubToken || !newsRepo) console.log("News publishing is off until GITHUB_TOKEN and NEWS_REPO are set.");

const mail = (company: string) => {
  const mailbox = mailboxes.get(company);
  if (!mailbox) throw new Error(`No mailbox for ${company}.`);
  return mailbox;
};
const memory = new Memory(createS3());
await memory.ready();
const files = new LDrive(setting("LDRIVE_URL"), setting("LDRIVE_API_KEY"));

const app = createGatewayApp({
  pool,
  callModel: createModelClient(setting("OPENROUTER_API_KEY")),
  mail,
  files,
  books: new QuirkBooks(setting("QUIRKBOOKS_URL"), setting("QUIRKBOOKS_API_KEY")),
  publisher: githubToken && newsRepo ? new GitHubPublisher(githubToken, newsRepo) : null,
  memory,
  tokens: { worker: setting("GATEWAY_WORKER_TOKEN"), dispatcher: setting("GATEWAY_DISPATCHER_TOKEN") },
});

// The world apps' notices stop when a watch runs out, so the gateway renews them every hour.
async function renew() {
  try {
    const renewed = await renewWatches({ pool, hooksUrl: setting("HOOKS_URL"), mail, files });
    if (renewed.length) console.log(`Renewed watches: ${renewed.join(", ")}.`);
  } catch (error) {
    console.error("Could not renew the world apps' watches; trying again in an hour:", error);
  }
}
await renew();
const renewal = setInterval(() => void renew(), 60 * 60 * 1000);

const server = listen(app, "Gateway", Number(setting("GATEWAY_PORT")));
server.on("close", () => {
  clearInterval(renewal);
  void stopTracing().then(() => pool.end());
});
