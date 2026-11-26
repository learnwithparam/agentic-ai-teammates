import { Annotation, type BaseCheckpointSaver, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import { type DueBill, DueBillSchema, payProblems, runTotal } from "../../payments";
import type { Run, StopReason } from "../../run";

// The payments teammate's pay run, as one LangGraph graph. Nothing in it calls a model.
// The books say which bills are due, which bank each was posted with, and what the run totals.
// Plain code reads those facts and decides. A person approves every run.
// Each pay day is its own thread, so a run that stops part way picks up at its last step.
//
//   find -> check -> propose (one card for the whole run) -> wait -> pay_approved

export type Result = { outcome: StopReason; note: string };
export type Decision = { status: "approved" | "denied"; approvalId: string };

// A bill due within this many days, or already overdue, is in the run.
export const PAY_WINDOW_DAYS = 5;

const State = Annotation.Root({
  day: Annotation<string>,
  due: Annotation<DueBill[]>,
  // The bills this run pays, and the ones it held back with the reason.
  payable: Annotation<DueBill[]>,
  held: Annotation<{ bill: DueBill; problems: string[] }[]>,
  approvalId: Annotation<string | null>,
  decision: Annotation<Decision | null>,
  result: Annotation<Result | null>,
});
type State = typeof State.State;

export const FRESH_STATE = { due: [], payable: [], held: [], approvalId: null, decision: null, result: null };

const Found = z.object({ bills: z.array(DueBillSchema) });
const Refusal = z.object({ billId: z.string(), reason: z.string() });
const Paid = z.object({ paid: z.array(z.string()), refused: z.array(Refusal) });

export const money = (amount: number) => amount.toFixed(2);

function heldNote(held: State["held"]): string {
  return held.map(({ bill, problems }) => `${bill.vendor} ${bill.invoiceNumber}: ${problems.join(" ")}`).join(" ");
}

export function paymentsGraph(checkpointer: BaseCheckpointSaver, runOf: (runId: string) => Run, currency: (company: string) => string) {
  const runFor = (config: LangGraphRunnableConfig) => runOf(String(config.configurable?.run_id));
  const threadOf = (config: LangGraphRunnableConfig) => String(config.configurable?.thread_id);

  async function find(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
    const run = runFor(config);
    const found = await run.tool(threadOf(config), "books.due_bills", { day: state.day, withinDays: PAY_WINDOW_DAYS });
    if (found.status !== "done") return { result: { outcome: "handed_to_human", note: found.status === "denied" ? found.reason : "Reading the bills asked for a person." } };
    const { bills } = Found.parse(found.result);
    if (bills.length === 0) return { due: [], result: { outcome: "nothing_to_send", note: `No bill falls due within ${PAY_WINDOW_DAYS} days of ${state.day}.` } };
    return { due: bills };
  }

  // The same checks the gateway's guard runs, run first so a run with a bad bill still pays the rest.
  async function check(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
    const run = runFor(config);
    const companyCurrency = currency(run.ref.company);
    const held = state.due.map((bill) => ({ bill, problems: payProblems(bill, companyCurrency) })).filter((item) => item.problems.length > 0);
    const payable = state.due.filter((bill) => !held.some((item) => item.bill.id === bill.id));
    if (held.length) await run.note("note", "Some bills are held back from the pay run", { held: heldNote(held) });
    if (payable.length === 0) return { held, payable, result: { outcome: "handed_to_human", note: `Every bill due is held back. ${heldNote(held)}` } };
    return { held, payable };
  }

  // What the person approves: the exact bills, and the total and currency they add up to.
  function args(state: State, company: string) {
    return { day: state.day, billIds: state.payable.map((bill) => bill.id), total: runTotal(state.payable), currency: currency(company) };
  }

  async function propose(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
    const run = runFor(config);
    const result = await run.tool(threadOf(config), "books.pay_bill", args(state, run.ref.company));
    if (result.status === "needs_approval") return { approvalId: result.approvalId };
    if (result.status === "denied") return { result: { outcome: "handed_to_human", note: result.reason } };
    // A pay run always asks a person, so this is only reached if a standing rule changed that.
    return { result: paidResult(state, Paid.parse(result.result), null, currency(run.ref.company)) };
  }

  function paidResult(state: State, paid: z.infer<typeof Paid>, by: string | null, unit: string): Result {
    const total = runTotal(state.payable.filter((bill) => paid.paid.includes(bill.id)));
    const parts = [`Paid ${paid.paid.length} of ${state.payable.length} bills for ${state.day}, ${money(total)} ${unit}${by ? `, approved by ${by}` : ""}.`];
    if (paid.refused.length) parts.push(`QuirkBooks refused ${paid.refused.map((item) => item.reason).join(" ")}`);
    if (state.held.length) parts.push(`Held back: ${heldNote(state.held)}`);
    return { outcome: paid.refused.length || state.held.length ? "handed_to_human" : "sent", note: parts.join(" ") };
  }

  // The run ends here. A person's decision arrives as an inbox event and resumes the thread.
  async function wait(state: State): Promise<Partial<State>> {
    const decision = interrupt<{ approvalId: string }, Decision>({ approvalId: state.approvalId! });
    return { decision };
  }

  async function payApproved(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
    if (state.decision!.status === "denied") return { result: { outcome: "nothing_to_send", note: `The pay run for ${state.day} was turned down by a person.` } };
    const run = runFor(config);
    const result = await run.tool(threadOf(config), "books.pay_bill", args(state, run.ref.company), state.approvalId!);
    if (result.status !== "done") return { result: { outcome: "handed_to_human", note: result.status === "denied" ? result.reason : "The approved pay run asked for a person again." } };
    return { result: paidResult(state, Paid.parse(result.result), "a person", currency(run.ref.company)) };
  }

  const next = (step: string) => (state: State) => (state.result ? END : step);

  return new StateGraph(State)
    .addNode("find", find)
    .addNode("check", check)
    .addNode("propose", propose)
    .addNode("wait", wait)
    .addNode("pay_approved", payApproved)
    .addEdge(START, "find")
    .addConditionalEdges("find", next("check"), ["check", END])
    .addConditionalEdges("check", next("propose"), ["propose", END])
    .addConditionalEdges("propose", (state) => (state.approvalId && !state.result ? "wait" : END), ["wait", END])
    .addEdge("wait", "pay_approved")
    .addEdge("pay_approved", END)
    .compile({ checkpointer });
}
