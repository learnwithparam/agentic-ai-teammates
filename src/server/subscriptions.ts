import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { FileSource, MailSource } from "./adapters/types";
import { hookAddress } from "./hooks";
import { COMPANIES } from "./people";

// Keeps Mission Control subscribed to the world apps' notices. Like Gmail's watch and Drive's
// channels, a subscription runs out, so the gateway renews each one well before it does.
// It runs in the gateway because only the gateway holds the world apps' keys.

// Renew when less than this much time is left.
const RENEW_BEFORE_MS = 12 * 60 * 60 * 1000;

export async function renewWatches(deps: { pool: Pool; hooksUrl: string; mail: (company: string) => MailSource; files: FileSource }): Promise<string[]> {
  const renewed: string[] = [];
  for (const company of Object.values(COMPANIES)) {
    const mailSource = `lmail:${company.alias}`;
    if (await due(deps.pool, mailSource)) {
      const watch = await deps.mail(company.alias).watch(hookAddress(deps.hooksUrl, "lmail", company.alias));
      await save(deps.pool, mailSource, null, null, watch.expiration);
      renewed.push(mailSource);
    }

    const driveSource = `ldrive:${company.alias}`;
    if (await due(deps.pool, driveSource)) {
      const old = await deps.pool.query<{ channel_id: string | null }>("SELECT channel_id FROM subscriptions WHERE source = $1", [driveSource]);
      const token = randomBytes(24).toString("base64url");
      const channel = await deps.files.watch(hookAddress(deps.hooksUrl, "ldrive", company.alias), token);
      await save(deps.pool, driveSource, channel.channelId, token, channel.expiration);
      // The new channel is saved first, so no notice is lost between the two channels.
      const oldChannel = old.rows[0]?.channel_id;
      if (oldChannel) await deps.files.stopWatch(oldChannel).catch((error) => console.error(`Could not stop channel ${oldChannel}:`, error));
      renewed.push(driveSource);
    }
  }
  return renewed;
}

async function due(pool: Pool, source: string): Promise<boolean> {
  const { rows } = await pool.query<{ expires_at: Date }>("SELECT expires_at FROM subscriptions WHERE source = $1", [source]);
  return !rows[0] || rows[0].expires_at.getTime() - Date.now() < RENEW_BEFORE_MS;
}

async function save(pool: Pool, source: string, channelId: string | null, token: string | null, expiration: string) {
  await pool.query(
    `INSERT INTO subscriptions (source, channel_id, token, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (source) DO UPDATE SET channel_id = $2, token = $3, expires_at = $4, renewed_at = now()`,
    [source, channelId, token, expiration],
  );
}
