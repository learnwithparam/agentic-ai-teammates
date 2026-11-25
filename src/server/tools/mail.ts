import { z } from "zod";
import { HttpError } from "../../../apps/shared/server";
import { payloadHash } from "../canonical";
import { COMPANIES } from "../people";
import { pdfText } from "../pdf-text";
import { defineTool, readTool } from "./define";
import { Text } from "./shapes";
import { prompt } from "../prompts";

// The company's accounts mailbox: LMail, or Gmail when the deploy reads it.

const REPLY_RULES = prompt(import.meta.url, "reply");

export const mailTools = {
  "mail.history": readTool(
    "List the messages that arrived in the accounts mailbox after a history id.",
    z.object({ startHistoryId: z.string().regex(/^\d+$/) }),
    (ctx, args) => ctx.deps.mail(ctx.scope.company).history(args.startHistoryId),
  ),
  "mail.message": readTool("Read one email: sender, subject, body text and attachment names.", z.object({ id: Text }), async (ctx, args) => {
    const message = await ctx.deps.mail(ctx.scope.company).message(args.id);
    return { ...message, text: message.text.slice(0, 20_000) };
  }),
  "mail.attachment_text": readTool("Read the text of a PDF attached to an email.", z.object({ messageId: Text, attachmentId: Text }), async (ctx, args) => {
    const file = await ctx.deps.mail(ctx.scope.company).attachment(args.messageId, args.attachmentId);
    if (!file.contentType.includes("pdf")) throw new HttpError(422, "Only a PDF attachment can be read as text.");
    return pdfText(file.bytes);
  }),
  "mail.reply": defineTool({
    description: "Reply to an email from the accounts mailbox.",
    args: z.object({
      to: z.email(),
      subject: z.string().min(1).max(200),
      text: z.string().min(1).max(4000),
      inReplyTo: z.string().nullable(),
    }),
    decision: "classify",
    readOnly: false,
    judgeRules: REPLY_RULES,
    ruleReason: "A standing rule asks a person to approve every reply.",
    card: (args, reasons) => ({ title: `Reply to ${args.to}`, brief: reasons.join(" "), canAllowAlways: true }),
    run: async (ctx, args, grant) => {
      const { scope } = ctx;
      const { message } = await ctx.outbox.add({
        company: scope.company,
        teammate: scope.teammate,
        runId: scope.runId,
        target: "lmail.send",
        title: `Reply to ${args.to}: ${args.subject}`,
        idempotencyKey: `reply:${scope.threadId}:${payloadHash(args)}`,
        payload: { mailbox: COMPANIES[scope.company].accountsMailbox, ...args },
        status: grant.send,
        releasedBy: grant.decidedBy ?? undefined,
      });
      return { status: "done", result: { outboxId: message.id, status: message.status } };
    },
  }),
};
