import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { FileSource, MailSource } from "./adapters/types";
import { hookAddress } from "./hooks";
import { COMPANIES } from "./people";
import type { FileService, MailService } from "./services";

// Keeps Mission Control subscribed to the world apps' notices. Like Gmail's watch and Drive's
// channels, a subscription runs out, so the gateway renews each one well before it does.
// It runs in the gateway because only the gateway holds the world apps' keys. A subscription
// is also renewed at once when HOOKS_URL changes, so notices never go to an address left behind.
// Gmail and Google Drive cannot read from the start of time, so their first watch also keeps
// the cursor the first read begins at.

// Renew when less than this much time is left.
const RENEW_BEFORE_MS = 12 * 60 * 60 * 1000;

type Services = { mail: MailService; files: FileService };
const WORLD_APPS: Services = { mail: "lmail", files: "ldrive" };

export async function renewWatches(deps: { pool: Pool; hooksUrl: string; mail: (company: string) => MailSource; files: FileSource; services?: Services }): Promise<string[]> {
  const services = deps.services ?? WORLD_APPS;
  const renewed: string[] = [];
  for (const company of Object.values(COMPANIES)) {
    const mailSource = `${services.mail}:${company.alias}`;
    const mailAddress = hookAddress(deps.hooksUrl, services.mail, company.alias);
    if (await due(deps.pool, mailSource, mailAddress)) {
      // One watch per mailbox, as in Gmail: watching from a new address moves it there.
      const watch = await deps.mail(company.alias).watch(mailAddress);
      const start = services.mail === "gmail" ? watch.historyId : null;
      await save(deps.pool, mailSource, mailAddress, null, null, watch.expiration, start);
      renewed.push(mailSource);
    }

    const driveSource = `${services.files}:${company.alias}`;
    const driveAddress = hookAddress(deps.hooksUrl, services.files, company.alias);
    if (await due(deps.pool, driveSource, driveAddress)) {
      const old = await deps.pool.query<{ channel_id: string | null }>("SELECT channel_id FROM subscriptions WHERE source = $1", [driveSource]);
      const token = randomBytes(24).toString("base64url");
      const start = services.files === "gdrive" ? await deps.files.startPageToken() : null;
      const channel = await deps.files.watch(driveAddress, token);
      await save(deps.pool, driveSource, driveAddress, channel.channelId, token, channel.expiration, start);
      // The new channel is saved first, so no notice is lost between the two channels.
      const oldChannel = old.rows[0]?.channel_id;
      if (oldChannel) await deps.files.stopWatch(oldChannel).catch((error) => console.error(`Could not stop channel ${oldChannel}:`, error));
      renewed.push(driveSource);
    }
  }
  return renewed;
}

async function due(pool: Pool, source: string, address: string): Promise<boolean> {
  const { rows } = await pool.query<{ expires_at: Date; address: string | null }>(
    "SELECT expires_at, address FROM subscriptions WHERE source = $1",
    [source],
  );
  const held = rows[0];
  return !held || held.address !== address || held.expires_at.getTime() - Date.now() < RENEW_BEFORE_MS;
}

// The first start cursor is kept: a renewal must not skip what arrived since the first watch.
async function save(pool: Pool, source: string, address: string, channelId: string | null, token: string | null, expiration: string, start: string | null) {
  await pool.query(
    `INSERT INTO subscriptions (source, address, channel_id, token, expires_at, start_cursor) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source) DO UPDATE SET address = $2, channel_id = $3, token = $4, expires_at = $5,
       start_cursor = COALESCE(subscriptions.start_cursor, $6), renewed_at = now()`,
    [source, address, channelId, token, expiration, start],
  );
}
