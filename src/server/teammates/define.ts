import type { Attack } from "./attacks";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { ToolName } from "../tools";
import type { Teammate } from "../worker-loop";

// The one definition of a teammate. The core reads it and wires the rest.
// The worker runs its work. The gateway lets it call only its tools.
// The scheduler gives it its schedules. The hooks wake it only for the sources it listens to.
// Startup gives each company one.

// label is what a person reads on the teammate's Schedule tab, such as "Pay run".
export type Schedule = { name: string; cron: string; label: string };

// The day's summary, at six on a working evening.
export const DIGEST: Schedule = { name: "digest", cron: "0 18 * * 1-5", label: "The day's summary" };

// The weekly tidy of its notes, early on a Monday, before the week's work.
export const TIDY: Schedule = { name: "tidy", cron: "0 7 * * 1", label: "Tidy its notes" };

// The webhook sources a teammate can wake on: new mail in the accounts mailbox, a new file in the drive.
export type HookSource = "mail" | "drive";

// What the core supplies, switched on per teammate. The teammate's own work never sees these events.
export type Capabilities = {
  // A person can write to it in Mission Control. "read" answers from tools that only read.
  // "act" may also set follow-ups and keep notes and progress, the small writes marked modelMayCall.
  chat: { mode: "read" | "act"; reads: ToolName[] };
  // It may set its own follow-ups with team.follow_up. When one fires, the core looks again and tells the person.
  followUps: boolean;
  // It sends the day's summary when its digest schedule fires.
  digest: boolean;
  // Once a week it reads its notes and proposes shorter ones, as drafts a person sends or discards.
  tidy: boolean;
};

export type TeammateDefinition = {
  // The kind names the code. It is stored on each teammate row.
  kind: string;
  // The id each company's teammate gets when startup creates it, such as "invoices".
  id: string;
  name: string;
  // One sentence the board shows under the name when a person chooses the teammate.
  purpose: string;
  // The questions the conversation offers as one click, written for this teammate's job.
  asks: string[];
  // The only tools the gateway lets this teammate call.
  tools: ToolName[];
  schedules: Schedule[];
  listens: HookSource[];
  defaults: { dailyBudgetUsd: number };
  capabilities: Capabilities;
  // The kinds of teammate that may ask this one for work with team.ask_teammate. None when left out.
  takesAsksFrom?: string[];
  // The script that scores this teammate with real model calls, from the repo root. It is the
  // evidence for turning Quiet off: npm run teammate:eval -- <kind> runs it.
  evaluate: string;
  // The attacks only this teammate's job faces. npm run teammate:attack adds the shared ones.
  attacks: Attack[];
  // Builds the function that turns one batch of inbox events into work.
  work: (checkpointer: BaseCheckpointSaver) => Teammate;
};

const KIND = /^[a-z][a-z-]{1,30}$/;

export function defineTeammate(teammate: TeammateDefinition): TeammateDefinition {
  if (!KIND.test(teammate.kind) || !KIND.test(teammate.id)) throw new Error(`A teammate kind and id are lowercase words: ${teammate.kind}/${teammate.id}`);
  if (new Set(teammate.tools).size !== teammate.tools.length) throw new Error(`${teammate.kind} lists a tool twice.`);
  if (new Set(teammate.schedules.map((schedule) => schedule.name)).size !== teammate.schedules.length) throw new Error(`${teammate.kind} has two schedules with one name.`);
  const has = (tool: ToolName) => teammate.tools.includes(tool);
  const missing = (tool: ToolName, why: string) => {
    if (!has(tool)) throw new Error(`${teammate.kind} ${why}, so its tools must list ${tool}.`);
  };
  for (const tool of teammate.capabilities.chat.reads) missing(tool, "lets chat read with it");
  missing("memory.read", "reads its memory every run");
  missing("memory.reported", "reads what it told the person it answers");
  missing("team.remind", "can wait for an approval");
  if (teammate.capabilities.followUps) missing("team.follow_up", "sets follow-ups");
  if (teammate.capabilities.followUps || teammate.capabilities.chat.mode === "act") missing("memory.report", "tells people what it found");
  if (teammate.capabilities.digest) {
    missing("team.digest", "sends a digest");
    if (!teammate.schedules.some((schedule) => schedule.name === DIGEST.name)) throw new Error(`${teammate.kind} sends a digest, so it needs the digest schedule.`);
  }
  if (teammate.capabilities.tidy) {
    missing("memory.propose_tidy", "tidies its notes");
    if (!teammate.schedules.some((schedule) => schedule.name === TIDY.name)) throw new Error(`${teammate.kind} tidies its notes, so it needs the tidy schedule.`);
  }
  return teammate;
}
