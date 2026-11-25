import { estimateCost, type Tier } from "./models";

// Picks which model tier answers a call, or hands it to a person. It looks at the task, the risk,
// the budget left and how earlier tries of the same call went. The order is fast, then strong,
// then a person. It is a plain function, so the tests and the routing eval run it whole.

// Screening guards every other step, so it gets the deeper look. On the injection invoice the
// quick check missed 4 times in 10. The deeper look missed 0 in 10 and costs a fraction of a cent more.
export const FAST_TASKS = ["classify", "extract", "summarize", "answer"] as const;
export const STRONG_TASKS = ["screen", "investigate", "brief", "select"] as const;
export type Task = (typeof FAST_TASKS)[number] | (typeof STRONG_TASKS)[number];
export type Risk = "low" | "high";

// What happened on an earlier try of the same call.
export type Outcome = { tier: Tier; result: "schema_failure" | "low_confidence" | "error" };

// A null tier means a person takes the call.
export type Route = { tier: Tier | null; reason: string };

// What one strong call may cost: 6,000 tokens in and 1,500 out. Below this, a person takes over.
export const STRONG_CALL_ESTIMATE_USD = estimateCost("strong", 6000, 1500);

// The routing eval compares the routed setup with setups that always use one tier.
export const ROUTING_MODES = ["routed", "fast-only", "strong-only"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

const ALL_TASKS: readonly string[] = [...FAST_TASKS, ...STRONG_TASKS];
const HEAVY_TASKS: readonly string[] = STRONG_TASKS;

function failedHard(outcome: Outcome, risk: Risk): boolean {
  if (outcome.result === "low_confidence") return risk === "high";
  return true;
}

export function route(task: Task, risk: Risk, budgetLeft: number, prior: readonly Outcome[] = [], mode: RoutingMode = "routed"): Route {
  if (!ALL_TASKS.includes(task)) throw new Error(`Unknown task "${task}"`);
  if (prior.some((outcome) => outcome.tier === "strong")) {
    return { tier: null, reason: "The deeper look failed this call, so a person takes it." };
  }
  if (mode === "fast-only") {
    if (prior.length > 0) return { tier: null, reason: "The quick check failed, and this setup has no deeper look." };
    return { tier: "fast", reason: "This setup uses the quick check for everything." };
  }
  const escalate = prior.some((outcome) => failedHard(outcome, risk));
  const wantsStrong = mode === "strong-only" || HEAVY_TASKS.includes(task) || escalate;
  if (!wantsStrong) return { tier: "fast", reason: `${task} is quick, high-volume work.` };
  if (budgetLeft < STRONG_CALL_ESTIMATE_USD) {
    return { tier: null, reason: `${task} needs a deeper look, but only ${budgetLeft.toFixed(4)} dollars are left today.` };
  }
  if (escalate) return { tier: "strong", reason: `A deeper look, because the quick check failed at ${task}.` };
  if (mode === "strong-only") return { tier: "strong", reason: "This setup uses the deeper look for everything." };
  return { tier: "strong", reason: `${task} weighs options, so it gets a deeper look.` };
}
