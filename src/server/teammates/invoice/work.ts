import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import { z } from "zod";
import type { InboxEvent } from "../../inbox";
import { CapReached, type Run } from "../../run";
import { InvoiceSource } from "../../tools";
import { stableUuid } from "../../tools/team";
import { type Decision, invoiceGraph, type Result } from "./graph";

// The invoice teammate. It turns a batch of inbox events into work: each PDF or invoice email
// is one thread of the invoice graph, and an approval decision resumes the thread that asked.

// Only files dropped in this LDrive folder are invoices.
export const INVOICE_FOLDER = "Invoices";

const History = z.object({ messageIds: z.array(z.string()), historyId: z.string() });
const Message = z.object({
  id: z.string(),
  messageId: z.string(),
  from: z.string(),
  subject: z.string(),
  text: z.string(),
  attachments: z.array(z.object({ id: z.string(), filename: z.string(), contentType: z.string() })),
});
const Changes = z.object({
  added: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      folder: z.string(),
      contentType: z.string(),
    }),
  ),
  nextToken: z.string(),
});
const DecidedPayload = z.object({ approvalId: z.string(), threadId: z.string(), status: z.enum(["approved", "denied"]) });
// A document a person handed over in chat. Only the gateway writes this event, from the person's token.
const RequestPayload = z.object({ requestId: z.uuid(), person: z.email(), from: z.string(), source: InvoiceSource });
type Request = z.infer<typeof RequestPayload>;

type Work =
  | { threadId: string; start: { source: InvoiceSource; body: string | null; requestId: string | null }; request?: Request }
  | { threadId: string; resume: Decision };

export function invoiceTeammate(checkpointer: BaseCheckpointSaver) {
  const runs = new Map<string, Run>();
  const graph = invoiceGraph(checkpointer, (runId) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`Run ${runId} is not running in this worker.`);
    return run;
  });

  return async function work(run: Run, batch: InboxEvent[]) {
    runs.set(run.ref.runId, run);
    try {
      // The core already handled chat and the shared timers, so the batch is the teammate's own work.
      for (const item of await plan(run, batch)) {
        try {
          const result = await runThread(run, item);
          if (result) run.outcome(item.threadId, result.outcome, result.note);
          // The person who handed the document over hears how it went, in their conversation.
          if ("request" in item && item.request) await tellRequester(run, graph, item.threadId, item.request);
        } catch (error) {
          if (!(error instanceof CapReached)) throw error;
          // A limit ends the run. The thread keeps its checkpoint and the cursors stay where they
          // were. The next event re-reads the source and carries on from the last finished step.
          run.outcome(item.threadId, "handed_to_human", error.message);
          run.holdCursors();
          return;
        }
      }
    } finally {
      runs.delete(run.ref.runId);
    }
  };

  async function runThread(run: Run, item: Work): Promise<Result | null> {
    const config = { configurable: { thread_id: item.threadId, run_id: run.ref.runId }, recursionLimit: 40 };
    const state = await graph.getState(config);
    if ("start" in item) {
      // A thread that finished, or waits for a person, is never started again, so a redelivered
      // email posts once. One a crash or a limit stopped part way carries on from its last step.
      if (state.values?.source && (state.next.length === 0 || state.next.includes("wait"))) return null;
      if (state.values?.source) await graph.invoke(null, config);
      else await graph.invoke({ ...item.start, text: null, invoice: null, facts: null, reasons: [], findings: null, brief: null, approvalId: null, decision: null, posted: false, result: null }, config);
    } else if (state.next.length > 0 && !state.next.includes("wait")) {
      // The decision was taken, then the worker stopped part way. Carry on from the last finished
      // step; the post's Idempotency-Key makes a post that already landed answer the same again.
      await graph.invoke(null, config);
    } else {
      if (!state.next.includes("wait")) {
        await run.note("note", "A decision arrived for a thread that is not waiting", { threadId: item.threadId });
        return null;
      }
      await graph.invoke(new Command({ resume: item.resume }), config);
    }
    const after = await graph.getState(config);
    if (after.next.includes("wait")) return { outcome: "deferred", note: `${titleOf(after.values)} waits for a person.` };
    return after.values.result ?? null;
  }
}

// What this batch of events asks for, oldest first. Reading mail and the drive moves the
// run's cursors, which are saved only when the run finishes.
async function plan(run: Run, events: InboxEvent[]): Promise<Work[]> {
  const work: Work[] = [];
  const mailEvents = events.filter((event) => event.type === "mail.received");
  const driveEvents = events.filter((event) => event.type === "drive.changed");
  if (mailEvents.length) work.push(...(await newMail(run)));
  if (driveEvents.length) work.push(...(await newFiles(run)));
  for (const event of events.filter((event) => event.type === "person.request" && event.source === "request")) {
    const request = RequestPayload.parse(event.payload);
    work.push({ threadId: `invoice:request:${request.requestId}`, start: { source: request.source, body: null, requestId: request.requestId }, request });
  }
  for (const event of events.filter((event) => event.type === "approval.decided")) {
    const decided = DecidedPayload.parse(event.payload);
    work.push({ threadId: decided.threadId, resume: { status: decided.status, approvalId: decided.approvalId } });
  }
  return work;
}

async function newMail(run: Run): Promise<Work[]> {
  const from = (await run.cursor("mail")) ?? "0";
  const scan = `mail:${run.ref.runId}`;
  const history = History.parse(await read(run, scan, "mail.history", { startHistoryId: from }));
  const work: Work[] = [];
  for (const id of history.messageIds) {
    const message = Message.parse(await read(run, scan, "mail.message", { id }));
    const base = { kind: "mail" as const, id: message.id, sender: message.from, subject: message.subject, messageId: message.messageId };
    const pdfs = message.attachments.filter((attachment) => attachment.contentType.includes("pdf"));
    for (const pdf of pdfs) work.push({ threadId: `invoice:mail:${message.id}:${pdf.id}`, start: { source: { ...base, attachmentId: pdf.id }, body: null, requestId: null } });
    // An email with no PDF may hold its invoice in the body. The screen step decides.
    if (pdfs.length === 0) work.push({ threadId: `invoice:mail:${message.id}`, start: { source: { ...base, attachmentId: null }, body: message.text, requestId: null } });
  }
  run.advanceCursor("mail", history.historyId);
  return work;
}

async function newFiles(run: Run): Promise<Work[]> {
  const from = (await run.cursor("drive")) ?? "0";
  const changes = Changes.parse(await read(run, `drive:${run.ref.runId}`, "drive.changes", { pageToken: from }));
  run.advanceCursor("drive", changes.nextToken);
  return changes.added
    .filter((file) => file.folder === INVOICE_FOLDER && file.contentType.includes("pdf"))
    .map((file) => ({
      threadId: `invoice:drive:${file.id}`,
      start: { source: { kind: "drive" as const, id: file.id, attachmentId: null, sender: null, subject: file.name, messageId: null }, body: null, requestId: null },
    }));
}

async function read(run: Run, threadId: string, tool: "mail.history" | "mail.message" | "drive.changes", args: unknown): Promise<unknown> {
  const result = await run.tool(threadId, tool, args);
  if (result.status !== "done") throw new Error(`${tool} did not run: ${result.status}.`);
  return result.result;
}

// One line in the person's conversation. The message id comes from the request, so a retry writes it once.
async function tellRequester(run: Run, graph: ReturnType<typeof invoiceGraph>, threadId: string, request: Request) {
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const title = titleOf(state.values);
  const text = state.next.includes("wait")
    ? `${title} waits for a person to approve it. It is on the board.`
    : (state.values.result?.note ?? `${title} is done.`);
  await run.reply(request.person, stableUuid(`request:${request.requestId}`), text);
}

function titleOf(values: { invoice?: { vendorName: string; invoiceNumber: string } | null; source?: InvoiceSource }): string {
  if (values.invoice) return `${values.invoice.vendorName} invoice ${values.invoice.invoiceNumber}`;
  return values.source?.subject ? `"${values.source.subject}"` : "A document";
}
