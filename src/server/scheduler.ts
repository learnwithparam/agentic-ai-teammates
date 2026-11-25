import { createPool, describeError, migrate } from "./db";
import { requireSettings, setting } from "./env";
import { ensureStandingSchedules } from "./scheduler-loop";
import { fireDue } from "./timers";

// The scheduler process. Start it with npm run scheduler. It turns due timers into inbox events
// and nothing more: the worker does the work, so a timer never starts a run by itself.

requireSettings(["DATABASE_URL"]);

// Timers are set to the minute, so checking every few seconds is close enough and costs little.
const POLL_MS = 5000;

const pool = createPool(setting("DATABASE_URL"));
await migrate(pool);
await ensureStandingSchedules(pool);

let stopping = false;

async function loop() {
  while (!stopping) {
    try {
      for (const timer of await fireDue(pool)) console.log(`${timer.teammate}: ${timer.name} fired.`);
    } catch (error) {
      console.error(`The scheduler could not read the timers: ${describeError(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

console.log("Scheduler is watching the timers.");
const running = loop();

async function shutdown() {
  stopping = true;
  await running;
  await pool.end();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
