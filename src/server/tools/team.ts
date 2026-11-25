import { z } from "zod";
import { HttpError } from "../../../apps/shared/server";
import { deciders } from "../members";
import { COMPANIES } from "../people";
import { digestMail, reminderMail, safeLine } from "../team-mail";
import { createHash, randomUUID } from "node:crypto";
import { Inbox } from "../inbox";
import { setTimer } from "../timers";
import { defineTool, type ToolContext, type ToolResult } from "./define";
import { asker, decides } from "./asker";
import { Day, type InvoiceSource } from "./shapes";
import { prompt } from "../prompts";

const HAND_OVER_RULES = prompt(import.meta.url, "hand-over");

const Document = z.object({
  kind: z.enum(["mail", "drive"]),
  id: z.string().min(1).max(200),
  attachmentId: z.string().min(1).max(200).nullable(),
});

// Reads the document from the app itself, so the request carries the real sender and subject.
async function documentSource(ctx: ToolContext, document: z.infer<typeof Document>): Promise<InvoiceSource | null> {
  try {
    if (document.kind === "mail") {
      const message = await ctx.deps.mail(ctx.scope.company).message(document.id);
      if (document.attachmentId && !message.attachments.some((attachment) => attachment.id === document.attachmentId)) return null;
      return { kind: "mail", id: message.id, attachmentId: document.attachmentId, sender: message.from, subject: message.subject, messageId: message.messageId };
    }
    const { file } = await ctx.deps.files.content(document.id);
    return { kind: "drive", id: file.id, attachmentId: null, sender: null, subject: file.name, messageId: null };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

export function stableUuid(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

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
      // It reports to the person this run is answering, never to someone the model names. Only
      // someone whose chat may use tools gets a follow-up that reads with them.
      const asked = await asker(ctx);
      if (asked && asked.reach !== "tools") return { deny: "Only someone the teammate may read for can ask it to follow up." };
      return { state: asked?.person ?? null };
    },
    card: (args) => ({ title: `A follow-up on ${safeLine(args.about, 60)}`, brief: safeLine(args.reason, 200), canAllowAlways: true }),
    run: async (ctx, args, _grant, person) => {
      const name = `${FOLLOW_UP_PREFIX}${randomUUID()}`;
      await setTimer(ctx.deps.pool, ctx.scope.company, ctx.scope.teammate, name, { at: new Date(args.at) }, {
        about: safeLine(args.about, 200), reason: safeLine(args.reason, 300), person: person ?? null, task: args.task ?? null,
      });
      return { status: "done", result: { followUp: name, at: args.at, tells: person ?? null } };
    },
  }),
  // A person hands the teammate a document to do its job on, such as a bill to post. The gateway
  // takes the person from the run, checks the document is real, and writes a person.request
  // event. Every check still runs, and anything over the person's own limit waits for someone else.
  "team.hand_over": defineTool({
    description: "Hand yourself a document the person asked you to work on, such as an invoice to post. Name it by its mail id and attachment id, or its drive file id.",
    args: z.object({ document: Document, ask: z.string().min(1).max(300) }),
    // The model has read mail on the way here, and a mail can ask for a hand-over. So the quick
    // check reads the person's own words and the document's real sender, never the model's ask.
    decision: "classify",
    judgeRules: HAND_OVER_RULES,
    readOnly: false,
    modelMayCall: true,
    guard: async (ctx, args) => {
      const asked = await asker(ctx);
      if (!asked) return { deny: "Only a person's message can hand over work." };
      if (!decides(asked.authority)) return { deny: "Only someone who decides approvals can hand over work. Others can ask questions." };
      const source = await documentSource(ctx, args.document);
      if (!source) return { deny: "There is no such document, or it has no such attachment." };
      return {
        state: { asked, source },
        judgeWith: { personWrote: asked.text, document: { kind: source.kind, sender: source.sender, subject: source.subject } },
      };
    },
    card: (args) => ({ title: "Work handed over", brief: safeLine(args.ask, 200), canAllowAlways: false }),
    run: async (ctx, args, _grant, state) => {
      const asked = state?.asked ?? (await asker(ctx));
      const source = state?.source ?? (await documentSource(ctx, args.document));
      if (!asked || !source) return { status: "denied", reason: "Only a person's message can hand over work, and only a document that exists." };
      // The same document handed over in the same message is one request, however often the run retries.
      const requestId = stableUuid(`${ctx.scope.company}/${ctx.scope.teammate}/${asked.messageId}/${source.kind}/${source.id}/${source.attachmentId}`);
      await new Inbox(ctx.deps.pool).receive({
        company: ctx.scope.company, teammate: ctx.scope.teammate, source: "request", sourceId: requestId, type: "person.request",
        payload: { requestId, person: asked.person, from: asked.from, ask: safeLine(args.ask, 300), source, authority: asked.authority },
      });
      return { status: "done", result: { requestId, document: source.subject ?? source.id } };
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
