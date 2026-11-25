import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { Teammate } from "../worker-loop";
import type { TeammateDefinition } from "./define";
import { handleFollowUps } from "./follow-ups";
import { handleMessages } from "./messages";
import { handleTimers } from "./timed";

// Wraps a teammate's own work with what its definition switches on. Each step takes the events it
// owns and passes the rest on, so the teammate's graph only ever sees its real work.
export function teammateWork(definition: TeammateDefinition, checkpointer: BaseCheckpointSaver): Teammate {
  const work = definition.work(checkpointer);
  const own = new Set(definition.schedules.map((schedule) => schedule.name).filter((name) => name !== "digest"));
  return async (run, batch) => {
    let events = await handleTimers(run, batch, { own, digest: definition.capabilities.digest });
    events = await handleFollowUps(run, events, definition);
    events = await handleMessages(run, events, definition);
    if (events.length) await work(run, events);
  };
}
