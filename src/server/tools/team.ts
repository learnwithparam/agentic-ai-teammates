import { z } from "zod";
import { HttpError } from "../../../apps/shared/server";
import { deciders } from "../members";
import { COMPANIES } from "../people";
import { digestMail, reminderMail, safeLine } from "../team-mail";
import { randomUUID } from "node:crypto";
import { setTimer } from "../timers";
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

// A follow-up the teammate sets for itself is bounded, so a run cannot fill the timers.
export const FOLLOW_UP_DAYS = 14;
export const OPEN_FOLLOW_UPS = 20;
export const FOLLOW_UP_PREFIX = "follow:";

export const FollowUp = z.object({
  about: z.string().min(1).max(200),
  at: z.iso.datetime({ offset: true }),
  reason: z.string().min(1).max(300),
  // The person to tell what the follow-up found. They must already talk to this teammate.
  person: z.email().optional(),
  // The progress file the follow-up reads when it fires.
  task: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
});

export const teamTools = {
  "team.follow_up": defineTool({
    description: `Set a follow-up for yourself: a time, at most ${FOLLOW_UP_DAYS} days ahead, when you look at something again. Say what and why.`,
    args: FollowUp,
    decision: "allow",
    readOnly: false,
    modelMayCall: true,
    guard: async (ctx, args) => {
      const at = new Date(args.at).getTime();
      const now = Date.now();
      if (at <= now) return { deny: "A follow-up must be in the future." };
      if (at > now + FOLLOW_UP_DAYS * 86_400_000) return { deny: `A follow-up can be at most ${FOLLOW_UP_DAYS} days ahead.` };
      const { pool } = ctx.deps;
      const open = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM timers WHERE company = $1 AND teammate = $2 AND name LIKE $3 AND status = 'waiting'",
        [ctx.scope.company, ctx.scope.teammate, `${FOLLOW_UP_PREFIX}%`],
      );
      if (open.rows[0].count >= OPEN_FOLLOW_UPS) return { deny: `This teammate already has ${OPEN_FOLLOW_UPS} follow-ups waiting.` };
      if (args.person) {
        const known = await pool.query("SELECT 1 FROM conversation WHERE company = $1 AND teammate = $2 AND person = $3 AND role = 'person' LIMIT 1", [
          ctx.scope.company, ctx.scope.teammate, args.person,
        ]);
        if (!known.rowCount) return { deny: "A follow-up can only report to a person who has written to this teammate." };
      }
      return {};
    },
    card: (args) => ({ title: `A follow-up on ${safeLine(args.about, 60)}`, brief: safeLine(args.reason, 200), canAllowAlways: true }),
    run: async (ctx, args) => {
      const name = `${FOLLOW_UP_PREFIX}${randomUUID()}`;
      await setTimer(ctx.deps.pool, ctx.scope.company, ctx.scope.teammate, name, { at: new Date(args.at) }, {
        about: safeLine(args.about, 200), reason: safeLine(args.reason, 300), person: args.person ?? null, task: args.task ?? null,
      });
      return { status: "done", result: { followUp: name, at: args.at } };
    },
  }),
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
