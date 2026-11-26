import { z } from "zod";
import { type Reason, REASONS } from "../checks";
import { payloadHash } from "../canonical";
import { isMemoryPath, NOTE_LINES, notePath, REPORTED, vendorTopic } from "../memory";
import { safeLine } from "../team-mail";
import { matchVendor, PostBillArgs } from "./books";
import { defineTool, readTool } from "./define";
import { prompt } from "../prompts";

const Topic = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const Line = z.string().min(1).max(300);

const NOTE_RULES = prompt(import.meta.url, "note");

// The teammate's own memory. It reads its files; only the gateway writes them.

export const memoryTools = {
  // A line in a note the teammate keeps. Text from outside could try to plant an order for later
  // runs. So the quick model judges each line, and a person decides when it is unsure.
  "memory.note": defineTool({
    description: "Keep one line in a note, such as what a vendor said. Name the note by topic, for example vendor-v-007.",
    args: z.object({ topic: Topic, line: Line }),
    decision: "classify",
    label: "Keep a note",
    readOnly: false,
    modelMayCall: true,
    judgeRules: NOTE_RULES,
    card: (args) => ({ title: `A note in ${notePath(args.topic)}`, brief: safeLine(args.line, 200), canAllowAlways: true }),
    run: async (ctx, args) => {
      const { added } = await ctx.deps.memory.addLine(ctx.scope, args.topic, safeLine(args.line, 300));
      return { status: "done", result: { note: notePath(args.topic), added } };
    },
  }),
  // Where a task that spans runs got to, so the run that picks it up later starts from there.
  "memory.progress": defineTool({
    description: "Write one line of progress on a task that spans runs, such as lumen-bank-check.",
    args: z.object({ task: Topic, line: Line }),
    // A later run reads this line, so it is judged like a note.
    decision: "classify",
    judgeRules: NOTE_RULES,
    label: "Write task progress",
    readOnly: false,
    modelMayCall: true,
    card: (args) => ({ title: `Progress on ${args.task}`, brief: safeLine(args.line, 200), canAllowAlways: true }),
    run: async (ctx, args) => ({ status: "done", result: await ctx.deps.memory.addProgress(ctx.scope, args.task, safeLine(args.line, 300)) }),
  }),
  // What the teammate told a person. added is false when it told them the same before, and then
  // the caller stays silent. The core calls this; a model never does.
  "memory.report": defineTool({
    description: "Record what was told to a person, and refuse it when they were told the same before.",
    args: z.object({ person: z.email(), line: Line }),
    decision: "allow",
    label: "Record what a person was told",
    readOnly: false,
    card: () => ({ title: "A line in reported.md", brief: "A standing rule asks a person before each line.", canAllowAlways: true }),
    run: async (ctx, args) => ({ status: "done", result: await ctx.deps.memory.report(ctx.scope, args.person, safeLine(args.line, 300)) }),
  }),
  // The weekly tidy's proposal for one note. It is always a draft: memory never rewrites itself
  // until a person reads the new lines and sends them. The core calls this; a model never does.
  "memory.propose_tidy": defineTool({
    description: "Propose new lines for one note, as a draft a person sends or discards.",
    args: z.object({
      topic: Topic,
      lines: z.array(Line).max(NOTE_LINES),
      why: z.string().min(1).max(300),
    }),
    decision: "allow",
    label: "Propose a tidier note",
    readOnly: false,
    card: (args) => ({ title: `Tidy notes/${args.topic}.md`, brief: safeLine(args.why, 200), canAllowAlways: false }),
    run: async (ctx, args) => {
      const { scope } = ctx;
      const lines = args.lines.map((line) => safeLine(line, 300));
      // What the note held when the tidy read it. If it changes before a person sends the draft,
      // the draft is refused, so a line written in between is never lost.
      const before = payloadHash((await ctx.deps.memory.read(scope, notePath(args.topic))) ?? "");
      const { message } = await ctx.outbox.add({
        company: scope.company,
        teammate: scope.teammate,
        runId: scope.runId,
        target: "memory.tidy",
        title: `Tidy notes/${args.topic}.md: ${safeLine(args.why, 120)}`.slice(0, 200),
        idempotencyKey: `tidy:${scope.teammate}:${args.topic}:${payloadHash({ lines, before })}`,
        payload: { teammate: scope.teammate, topic: args.topic, lines, why: safeLine(args.why, 300), before },
        status: "draft",
      });
      return { status: "done", result: { outboxId: message.id } };
    },
  }),
  // reported.md holds what was told to everyone, so a model never reads it whole.
  "memory.read": readTool(
    "Read one file of this teammate's memory: instructions.md, index.md, a note such as notes/vendor-v-007.md, or progress/<task>.md.",
    z.object({ path: z.string().refine((path) => isMemoryPath(path) && path !== REPORTED, "That is not a memory file a model may read.") }),
    async (ctx, args) => ({ text: await ctx.deps.memory.read(ctx.scope, args.path) }),
  ),
  // The lines of reported.md about one person. The core calls it for the person a run answers.
  // It is not read-only, so it is never offered to a model.
  "memory.reported": defineTool({
    description: "Read what this teammate already told one person.",
    args: z.object({ person: z.email() }),
    decision: "allow",
    label: "Read what a person was told",
    readOnly: false,
    card: () => ({ title: "What was told to a person", brief: "A standing rule asks a person before each read.", canAllowAlways: true }),
    run: async (ctx, args) => {
      const text = await ctx.deps.memory.read(ctx.scope, REPORTED);
      const own = (text ?? "").split("\n").filter((line) => line.startsWith(`- ${args.person}: `));
      return { status: "done", result: { text: own.length ? `${own.join("\n")}\n` : null } };
    },
  }),
  // Memory keeps what a person decided about a vendor, so the next invoice from that vendor can
  // show it. Every word comes from the approval: the decider, the checks, and the decider's own note.
  "memory.record_decision": defineTool({
    description: "Write a person's decision on an invoice into the vendor's note.",
    args: z.object({ approvalId: z.uuid() }),
    decision: "allow",
    label: "Record a decision",
    readOnly: false,
    card: () => ({ title: "A note in memory", brief: "A standing rule asks a person before each note.", canAllowAlways: true }),
    run: async (ctx, { approvalId }) => {
      const { scope } = ctx;
      const approval = await ctx.approvals.get(scope.company, approvalId);
      if (!approval || approval.teammate !== scope.teammate || approval.tool !== "books.post_bill") {
        return { status: "denied", reason: "There is no such invoice approval for this teammate." };
      }
      if (approval.status === "pending" || !approval.decidedAt) return { status: "denied", reason: "Nobody has decided this approval yet." };
      const { invoice, source } = PostBillArgs.parse(approval.args);
      const checks = approval.reasons.filter((reason): reason is Reason => reason in REASONS);
      const parts = [
        `${approval.decidedAt.slice(0, 10)}:`,
        `${approval.decidedByName ?? "A person"} ${approval.status} ${safeLine(invoice.invoiceNumber, 40)}`,
        `for ${invoice.total.toFixed(2)} ${invoice.currency}.`,
        `Checks that stopped it: ${checks.length ? checks.join(", ") : "a standing rule"}.`,
      ];
      if (approval.decisionNote) parts.push(`Their note: "${safeLine(approval.decisionNote, 160)}"`);
      // The note belongs to the vendor QuirkBooks matches. An invoice that matches none, or one
      // that names a vendor it did not come from, is never written into a real vendor's history.
      const vendor = await matchVendor(ctx.deps.books, invoice, source);
      if (!vendor) return { status: "done", result: { note: null, added: false } };
      const topic = vendorTopic(vendor.id);
      const { added } = await ctx.deps.memory.addLine(scope, topic, parts.join(" "));
      return { status: "done", result: { note: notePath(topic), added } };
    },
  }),
};
