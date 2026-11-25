import { z } from "zod";
import { type Reason, REASONS } from "../checks";
import { INSTRUCTIONS, NOTE_PATH, notePath, vendorTopic } from "../memory";
import { safeLine } from "../team-mail";
import { matchVendor, PostBillArgs } from "./books";
import { defineTool, readTool } from "./define";

// The teammate's own memory. It reads its files; only the gateway writes them.

export const memoryTools = {
  "memory.read": readTool(
    "Read one file of this teammate's memory: instructions.md, or a note such as notes/vendor-lumen-print-house.md.",
    z.object({ path: z.union([z.literal(INSTRUCTIONS), z.string().regex(NOTE_PATH)]) }),
    async (ctx, args) => ({ text: await ctx.deps.memory.read(ctx.scope, args.path) }),
  ),
  // Memory keeps what a person decided about a vendor, so the next invoice from that vendor can
  // show it. Every word comes from the approval: the decider, the checks, and the decider's own note.
  "memory.record_decision": defineTool({
    description: "Write a person's decision on an invoice into the vendor's note.",
    args: z.object({ approvalId: z.uuid() }),
    decision: "allow",
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
