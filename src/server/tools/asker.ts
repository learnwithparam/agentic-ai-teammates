import { z } from "zod";
import type { Person } from "../auth";
import { ROLES } from "../people";
import type { ToolContext } from "./define";

// The person whose message this run is answering. The gateway reads it from the inbox row this
// run claimed, which the web server wrote from the person's signed token. A model can name any
// person in its arguments, so a tool that acts for someone takes them only from here.

// Who asked, as their signed token said when the web server took the message.
export const Authority = z.object({
  subject: z.string(),
  name: z.string(),
  email: z.email(),
  roles: z.array(z.enum(ROLES)),
  approvalLimit: z.number().nullable(),
});
const Asked = z.object({
  messageId: z.uuid(),
  text: z.string(),
  person: z.email(),
  from: z.string(),
  reach: z.enum(["board", "tools"]),
  authority: Authority,
});
export type Asker = z.infer<typeof Asked>;

const CHAT_THREAD = /^message:([0-9a-f-]{36})$/;

export async function asker(ctx: ToolContext): Promise<Asker | null> {
  const messageId = CHAT_THREAD.exec(ctx.scope.threadId)?.[1];
  if (!messageId) return null;
  const { rows } = await ctx.deps.pool.query<{ payload: unknown }>(
    `SELECT payload FROM inbox_events WHERE company = $1 AND teammate = $2 AND run_id = $3 AND type = 'person.message' AND source = 'person'
       AND payload->>'messageId' = $4 LIMIT 1`,
    [ctx.scope.company, ctx.scope.teammate, ctx.scope.runId, messageId],
  );
  const parsed = Asked.safeParse(rows[0]?.payload);
  return parsed.success ? parsed.data : null;
}

// The asker as OpenFGA sees them, for a check against their own approval limit.
export function askerAsPerson(authority: Asker["authority"], company: string): Person {
  return { ...authority, company, approvalLimit: authority.approvalLimit ?? undefined };
}

// Someone who decides approvals may hand a teammate work. Everyone else may only ask.
export function decides(authority: Asker["authority"]): boolean {
  return authority.roles.includes("admin") || authority.roles.includes("approver");
}
