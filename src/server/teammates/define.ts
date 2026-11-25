import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { ToolName } from "../tools";
import type { Teammate } from "../worker-loop";

// The one definition of a teammate. The core reads it and wires the rest.
// The worker runs its work. The gateway lets it call only its tools.
// The scheduler gives it its schedules. The hooks wake it only for the sources it listens to.
// Startup gives each company one.

export type Schedule = { name: string; cron: string };

// The day's summary, at six on a working evening.
export const DIGEST: Schedule = { name: "digest", cron: "0 18 * * 1-5" };

// The webhook sources a teammate can wake on: new mail in the accounts mailbox, a new file in the drive.
export type HookSource = "mail" | "drive";

export type TeammateDefinition = {
  // The kind names the code. It is stored on each teammate row.
  kind: string;
  // The id each company's teammate gets when startup creates it, such as "invoices".
  id: string;
  name: string;
  // One sentence the roster shows under the name.
  purpose: string;
  // The only tools the gateway lets this teammate call.
  tools: ToolName[];
  schedules: Schedule[];
  listens: HookSource[];
  defaults: { dailyBudgetUsd: number };
  // Builds the function that turns one batch of inbox events into work.
  work: (checkpointer: BaseCheckpointSaver) => Teammate;
};

const KIND = /^[a-z][a-z-]{1,30}$/;

export function defineTeammate(teammate: TeammateDefinition): TeammateDefinition {
  if (!KIND.test(teammate.kind) || !KIND.test(teammate.id)) throw new Error(`A teammate kind and id are lowercase words: ${teammate.kind}/${teammate.id}`);
  if (new Set(teammate.tools).size !== teammate.tools.length) throw new Error(`${teammate.kind} lists a tool twice.`);
  if (new Set(teammate.schedules.map((schedule) => schedule.name)).size !== teammate.schedules.length) throw new Error(`${teammate.kind} has two schedules with one name.`);
  return teammate;
}
