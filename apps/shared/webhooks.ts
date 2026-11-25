import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Webhook } from "standardwebhooks";
import { HttpError } from "./server";

// A world app tells subscribers about a change with a signed POST (the Standard Webhooks
// format: webhook-id, webhook-timestamp, webhook-signature). Each notice is a row first, so a
// subscriber that is down gets it later: retries wait twice as long each time, up to a day.

const MAX_ATTEMPTS = 12;
const BATCH = 20;

// Notices go only to Mission Control's hooks address (HOOKS_URL). A watch for any other
// address is refused, so a key holder cannot point the app at an inside service.
export function requireHookAddress(address: string, hooksUrl: string): string {
  const url = new URL(address);
  if (url.origin !== new URL(hooksUrl).origin) throw new HttpError(422, `Notices go only to ${new URL(hooksUrl).origin}.`);
  return url.href;
}

export type Notice = { url: string; type: string; body: unknown; headers?: Record<string, string> };

export class WebhookSender {
  private readonly signer: Webhook;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly pool: Pool,
    secret: string,
  ) {
    this.signer = new Webhook(secret);
  }

  async enqueue(notice: Notice): Promise<string> {
    const id = `msg_${randomUUID()}`;
    await this.pool.query("INSERT INTO webhook_deliveries (id, url, type, body, headers) VALUES ($1, $2, $3, $4, $5)", [
      id,
      notice.url,
      notice.type,
      JSON.stringify(notice.body),
      notice.headers ?? {},
    ]);
    return id;
  }

  // Sends every notice that is due. Returns how many went through.
  async deliverDue(): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; url: string; body: string; headers: Record<string, string>; attempts: number }>(
      `UPDATE webhook_deliveries SET attempts = attempts + 1, next_at = now() + interval '1 minute'
       WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'waiting' AND next_at <= now()
                    ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
       RETURNING id, url, body::text AS body, headers, attempts`,
    );
    let delivered = 0;
    for (const row of rows) {
      const signature = this.signer.sign(row.id, new Date(), row.body);
      const now = Math.floor(Date.now() / 1000).toString();
      let error: string | null = null;
      try {
        const response = await fetch(row.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "webhook-id": row.id, "webhook-timestamp": now, "webhook-signature": signature, ...row.headers },
          body: row.body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) error = `The subscriber answered ${response.status}.`;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
      if (!error) {
        delivered += 1;
        await this.pool.query("UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = $1", [row.id]);
        continue;
      }
      const dead = row.attempts >= MAX_ATTEMPTS;
      await this.pool.query(
        `UPDATE webhook_deliveries SET status = $2, last_error = $3,
         next_at = now() + make_interval(secs => least(86400, 2 ^ attempts)) WHERE id = $1`,
        [row.id, dead ? "dead" : "waiting", error],
      );
    }
    return delivered;
  }

  start(everyMs = 1000) {
    const tick = () => {
      this.deliverDue()
        .catch((error) => console.error("webhook delivery:", error instanceof Error ? error.message : error))
        .finally(() => {
          this.timer = setTimeout(tick, everyMs);
        });
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }
}
