import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createPool, migrate } from "./db";
import { requireSettings, setting } from "./env";
import { GatewayClient } from "./gateway-client";
import { Inbox, listenForEvents } from "./inbox";
import { invoiceTeammate } from "./teammates/invoice";
import { startTracing } from "./tracing";
import { workOnce } from "./worker-loop";

// The worker process. Start it with npm run worker. It holds no model key and no world app key:
// every model and tool call goes through the gateway.

requireSettings(["DATABASE_URL", "GATEWAY_URL", "GATEWAY_WORKER_TOKEN", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"]);

// A notice wakes the worker at once; this poll catches a notice lost while it reconnected.
const POLL_MS = 5000;

const stopTracing = startTracing("worker");
const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);
const checkpointer = new PostgresSaver(pool);
await checkpointer.setup();

const options = {
  pool,
  gateway: new GatewayClient(setting("GATEWAY_URL"), setting("GATEWAY_WORKER_TOKEN")),
  inbox: new Inbox(pool),
  kinds: { invoice: invoiceTeammate(checkpointer) },
};

let stopping = false;
let wake: () => void = () => {};
const stopListening = await listenForEvents(pool, () => wake());

async function loop() {
  while (!stopping) {
    try {
      for (const run of await workOnce(options)) console.log(`${run.company}/${run.teammate}: ${run.events} events, ${run.stop}.`);
    } catch (error) {
      console.error("The worker could not read the inbox:", error);
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

console.log("Worker is waiting for inbox events.");
const running = loop();

// A stop lets the run in hand finish, so its events are settled and not left to a lease.
async function shutdown() {
  stopping = true;
  wake();
  await running;
  await stopListening();
  await stopTracing();
  await pool.end();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
