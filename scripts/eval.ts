import { spawnSync } from "node:child_process";
import { TEAMMATES } from "../src/server/teammates/registry";

// Runs the eval each teammate declares, with real model calls through the gateway.
//
//   npm run teammate:eval -- invoice
//   npm run teammate:eval -- all --routing all
//
// Anything after the kind goes to the eval itself. It fails when any eval fails.

const [kind, ...rest] = process.argv.slice(2);
const kinds = TEAMMATES.map((teammate) => teammate.kind);
if (!kind || (kind !== "all" && !kinds.includes(kind))) throw new Error(`Name a teammate: all, ${kinds.join(", ")}.`);
const chosen = TEAMMATES.filter((teammate) => kind === "all" || teammate.kind === kind);

const failed: string[] = [];
for (const teammate of chosen) {
  console.log(`\n${teammate.name}: ${teammate.evaluate}`);
  const result = spawnSync("npx", ["tsx", teammate.evaluate, ...rest], { stdio: "inherit" });
  if (result.status !== 0) failed.push(teammate.kind);
}
if (failed.length) {
  console.error(`\nThe eval failed for ${failed.join(", ")}.`);
  process.exit(1);
}
