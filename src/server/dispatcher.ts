import { createPool, migrate } from "./db";
import { drain } from "./dispatcher-loop";
import { requireSettings, setting } from "./env";
import { GatewayClient } from "./gateway-client";
import { Outbox } from "./outbox";

// The dispatcher process. Start it with npm run dispatcher. It sends what the outbox holds, at
// the pace the outbox allows, and retries what a retry can fix.

requireSettings(["DATABASE_URL", "GATEWAY_URL", "GATEWAY_DISPATCHER_TOKEN"]);

// Each target may send once every two seconds, so a short poll keeps the pace without a queue.
const POLL_MS = 1000;

const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);
const outbox = new Outbox(pool);
const gateway = new GatewayClient(setting("GATEWAY_URL"), setting("GATEWAY_DISPATCHER_TOKEN"));

let stopping = false;

async function loop() {
  while (!stopping) {
    try {
      for (const item of await drain(outbox, gateway)) {
        console.log(`${item.title}: ${item.outcome}${item.reason ? ` (${item.reason})` : ""}.`);
      }
    } catch (error) {
      console.error("The dispatcher could not read the outbox:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

console.log("Dispatcher is watching the outbox.");
const running = loop();

// A stop lets the send in hand finish, so no message is left to its lease.
async function shutdown() {
  stopping = true;
  await running;
  await pool.end();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
