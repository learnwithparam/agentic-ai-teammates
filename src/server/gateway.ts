import { listen } from "../../apps/shared/server";
import { QuirkBooks } from "./adapters/quirkbooks";
import { createPool, migrate } from "./db";
import { ensureTeammates } from "./teammates/ensure";
import { optionalSetting, requireSettings, setting } from "./env";
import { createGatewayApp } from "./gateway-app";
import { createModelClient } from "./llm";
import { Memory } from "./memory";
import { readArticle } from "./news/article";
import { collectStories } from "./news/sources";
import { createS3 } from "./s3";
import { chosenServices, newsPublisher, openSources } from "./services";
import { renewWatches } from "./subscriptions";
import { startTracing } from "./tracing";

// The gateway process. Start it with npm run gateway. It is the only process that holds the
// OpenRouter key, the world apps' keys and, for news on GitHub, the GitHub token.

requireSettings([
  "APP_URL", "DATABASE_URL", "OPENROUTER_API_KEY", "GATEWAY_PORT", "GATEWAY_WORKER_TOKEN", "GATEWAY_DISPATCHER_TOKEN",
  "QUIRKBOOKS_URL", "QUIRKBOOKS_API_KEY",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "HOOKS_URL",
  "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
]);

const stopTracing = startTracing("gateway");
const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);
await ensureTeammates(pool);

const services = chosenServices();
const { mail, files } = openSources(pool, services);
console.log(`Reading mail from ${services.mail} and files from ${services.files}.`);
const exaKey = optionalSetting("EXA_API_KEY");
console.log(exaKey ? "Exa is on as a news source." : "Exa is off as a news source until EXA_API_KEY is set.");

const storage = createS3();
const memory = new Memory(storage);
await memory.ready();
const news = await newsPublisher(storage);
console.log(news.target === "site" ? "News publishes to Mission Control's news page." : "News publishes to GitHub Pages.");

const app = createGatewayApp({
  pool,
  callModel: createModelClient(setting("OPENROUTER_API_KEY")),
  mail,
  files,
  books: new QuirkBooks(setting("QUIRKBOOKS_URL"), setting("QUIRKBOOKS_API_KEY")),
  publisher: news.publisher,
  memory,
  news: { collect: (desk) => collectStories(desk, exaKey ?? null), read: readArticle },
  tokens: { worker: setting("GATEWAY_WORKER_TOKEN"), dispatcher: setting("GATEWAY_DISPATCHER_TOKEN") },
});

// The world apps' notices stop when a watch runs out, so the gateway renews them every hour.
async function renew() {
  try {
    const renewed = await renewWatches({ pool, hooksUrl: setting("HOOKS_URL"), mail, files, services });
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
