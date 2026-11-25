import { timingSafeEqual } from "node:crypto";
import express, { type Router } from "express";
import type { Pool } from "pg";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { z } from "zod";
import { HttpError } from "../../apps/shared/server";
import type { Inbox } from "./inbox";
import { COMPANIES } from "./people";

// The webhook handlers. A handler checks the signature, stores the event in the inbox and
// answers at once. It never runs a teammate and never reads the message: the worker does that.
//
// LMail notices are shaped like Gmail's: { emailAddress, historyId }. LDrive notices are shaped
// like Drive's: X-Goog-* headers with the channel's secret token. Both are also signed with
// Standard Webhooks, each app with its own secret.

export const HOOK_PATHS = { lmail: "/hooks/lmail/:company", ldrive: "/hooks/ldrive/:company" } as const;

export function hookAddress(hooksUrl: string, app: "lmail" | "ldrive", company: string): string {
  return new URL(HOOK_PATHS[app].replace(":company", company), hooksUrl).href;
}

const MailNotice = z.object({ emailAddress: z.string(), historyId: z.string().regex(/^\d+$/) });

export function createHooksRouter(deps: { pool: Pool; inbox: Inbox; secrets: { lmail: string; ldrive: string } }): Router {
  const router = express.Router();
  const raw = express.raw({ type: "application/json", limit: "64kb" });
  const lmail = new Webhook(deps.secrets.lmail);
  const ldrive = new Webhook(deps.secrets.ldrive);

  router.post(HOOK_PATHS.lmail, raw, async (request, response) => {
    const company = companyOf(String(request.params.company));
    const notice = MailNotice.parse(verify(lmail, request.body, request.headers));
    if (notice.emailAddress.toLowerCase() !== company.accountsMailbox) throw new HttpError(422, "This mailbox is not the company's accounts mailbox.");
    const stored = await toTeammates(deps, company.alias, "invoice", {
      source: "lmail",
      sourceId: String(request.header("webhook-id")),
      type: "mail.received",
      payload: notice,
    });
    response.status(stored ? 202 : 200).json({ stored });
  });

  router.post(HOOK_PATHS.ldrive, raw, async (request, response) => {
    const company = companyOf(String(request.params.company));
    verify(ldrive, request.body, request.headers);
    const channelId = request.header("X-Goog-Channel-ID") ?? "";
    const token = request.header("X-Goog-Channel-Token") ?? "";
    const state = request.header("X-Goog-Resource-State");
    // The channel token is the second check: a notice for a channel we no longer hold is dropped.
    const { rows } = await deps.pool.query<{ channel_id: string; token: string }>(
      "SELECT channel_id, token FROM subscriptions WHERE source = $1",
      [`ldrive:${company.alias}`],
    );
    const held = rows[0];
    if (!held || held.channel_id !== channelId || !sameText(held.token, token)) throw new HttpError(401, "This channel is not one Mission Control holds.");
    // Drive sends "sync" once when a channel opens. It carries no change.
    if (state === "sync") {
      response.status(200).json({ stored: 0 });
      return;
    }
    const stored = await toTeammates(deps, company.alias, "invoice", {
      source: "ldrive",
      sourceId: `${channelId}:${request.header("X-Goog-Message-Number") ?? ""}`,
      type: "drive.changed",
      payload: { channelId },
    });
    response.status(stored ? 202 : 200).json({ stored });
  });

  return router;
}

function companyOf(alias: string) {
  const company = COMPANIES[alias];
  if (!company) throw new HttpError(404, "There is no such company.");
  return company;
}

// A bad or missing signature, or one older than five minutes, is refused before anything is stored.
function verify(signer: Webhook, body: unknown, headers: Record<string, string | string[] | undefined>): unknown {
  if (!Buffer.isBuffer(body)) throw new HttpError(415, "Send the notice as application/json.");
  const flat = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value ?? ""]));
  try {
    return signer.verify(body.toString("utf8"), flat);
  } catch (error) {
    if (error instanceof WebhookVerificationError) throw new HttpError(401, "The notice's signature does not match.");
    throw error;
  }
}

// One notice wakes every teammate of that kind. Returns how many new events were stored.
async function toTeammates(deps: { pool: Pool; inbox: Inbox }, company: string, kind: string, event: { source: string; sourceId: string; type: "mail.received" | "drive.changed"; payload: unknown }): Promise<number> {
  const { rows } = await deps.pool.query<{ id: string }>("SELECT id FROM teammates WHERE company = $1 AND kind = $2", [company, kind]);
  let stored = 0;
  for (const mate of rows) {
    const result = await deps.inbox.receive({ company, teammate: mate.id, ...event });
    if (result.first) stored += 1;
  }
  return stored;
}

function sameText(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first);
  const secondBytes = Buffer.from(second);
  return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
}
