import { z } from "zod";
import { HttpError } from "../../../apps/shared/server";
import { deciders } from "../members";
import { COMPANIES } from "../people";
import { digestMail, reminderMail } from "../team-mail";
import { defineTool, type ToolContext, type ToolResult } from "./define";
import { Day } from "./shapes";

// Notes to the company's own people who decide approvals. The gateway picks the recipients.
// It writes every word from its own records, so a teammate cannot send them elsewhere or put
// words in them. They go out even when the teammate is quiet: quiet holds back what reaches the
// outside world, and these never leave the company.

async function toDeciders(ctx: ToolContext, mail: { key: string; subject: string; text: string } | null): Promise<ToolResult> {
  const { scope } = ctx;
  const company = COMPANIES[scope.company];
  if (!company) throw new HttpError(404, "There is no such company.");
  if (!mail) return { status: "done", result: { queued: 0, note: "The approval was already decided." } };
  const people = await deciders(ctx.deps.pool, scope.company);
  if (people.length === 0) return { status: "denied", reason: "Nobody who decides approvals has signed in yet, so there is no one to write to." };
  for (const to of people) {
    await ctx.outbox.add({
      company: scope.company,
      teammate: scope.teammate,
      runId: scope.runId,
      target: "lmail.send",
      title: `${mail.subject} (to ${to})`.slice(0, 200),
      idempotencyKey: `${mail.key}:${to}`,
      payload: { mailbox: company.accountsMailbox, to, subject: mail.subject, text: mail.text, inReplyTo: null },
      status: "queued",
    });
  }
  return { status: "done", result: { queued: people.length } };
}

export const teamTools = {
  "team.remind": defineTool({
    description: "Remind the people who decide approvals that one is still waiting.",
    args: z.object({ approvalId: z.uuid() }),
    decision: "allow",
    readOnly: false,
    card: () => ({ title: "A reminder to the team", brief: "A standing rule asks a person before each reminder.", canAllowAlways: true }),
    run: async (ctx, args) => toDeciders(ctx, await reminderMail(ctx.deps.pool, COMPANIES[ctx.scope.company], args.approvalId)),
  }),
  "team.digest": defineTool({
    description: "Send the people who decide approvals the day's summary of this teammate's work.",
    args: z.object({ day: Day }),
    decision: "allow",
    readOnly: false,
    card: (args) => ({ title: `The summary for ${args.day}`, brief: "A standing rule asks a person before each summary.", canAllowAlways: true }),
    run: async (ctx, args) => toDeciders(ctx, await digestMail(ctx.deps.pool, COMPANIES[ctx.scope.company], ctx.scope.teammate, args.day)),
  }),
};
