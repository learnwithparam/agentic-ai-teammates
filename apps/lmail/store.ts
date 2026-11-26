import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { Pool, PoolClient } from "pg";
import { inTransaction } from "../../src/server/db";
import { HttpError } from "../shared/server";
import type { WebhookSender } from "../shared/webhooks";

// Where LMail keeps mail. Every change to a mailbox raises its history id by one and tells each
// watcher {emailAddress, historyId}, the same notice Gmail sends through Pub/Sub. A watcher then
// asks for the history since the last id it saw, so a lost or repeated notice loses nothing.

export type NewAttachment = { filename: string; contentType: string; content: Buffer };

export type IncomingMail = {
  messageId: string;
  inReplyTo?: string;
  fromAddress: string;
  fromName?: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments: NewAttachment[];
};

export type OutgoingMail = { to: string[]; subject: string; text: string; inReplyTo?: string; attachments?: NewAttachment[] };

export type MessageSummary = {
  id: string;
  folder: string;
  fromAddress: string;
  fromName: string | null;
  to: string[];
  subject: string;
  preview: string;
  unread: boolean;
  receivedAt: string;
  attachmentCount: number;
};

export type Message = MessageSummary & {
  mailbox: string;
  messageId: string;
  inReplyTo: string | null;
  text: string;
  html: string | null;
  historyId: string;
  attachments: { id: string; filename: string; contentType: string; size: number }[];
};

const WATCH_DAYS = 7;

export const normalize = (address: string) => address.trim().toLowerCase();

export class MailStore {
  constructor(
    private readonly pool: Pool,
    private readonly webhooks: WebhookSender,
    // An SMTP relay for mail to domains LMail does not host. Without one, such mail is refused.
    private readonly relayUrl?: string,
  ) {}

  async isLocal(address: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("SELECT 1 FROM mailboxes WHERE address = $1", [normalize(address)]);
    return rowCount === 1;
  }

  async hostsDomain(address: string): Promise<boolean> {
    const domain = normalize(address).split("@")[1] ?? "";
    const { rowCount } = await this.pool.query("SELECT 1 FROM domains WHERE name = $1", [domain]);
    return rowCount === 1;
  }

  // Files one message in one mailbox's folder, raises its history id and tells its watchers.
  private async file(client: PoolClient, mailbox: string, folder: "inbox" | "sent", mail: IncomingMail, idempotencyKey?: string) {
    const { rows } = await client.query<{ history_id: string }>(
      "UPDATE mailboxes SET history_id = history_id + 1 WHERE address = $1 RETURNING history_id",
      [mailbox],
    );
    const historyId = rows[0].history_id;
    const id = randomUUID();
    await client.query(
      `INSERT INTO messages (id, mailbox, folder, message_id, in_reply_to, from_address, from_name, to_addresses, subject,
       text_body, html_body, history_id, unread, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, mailbox, folder, mail.messageId, mail.inReplyTo ?? null, normalize(mail.fromAddress), mail.fromName ?? null,
        mail.to.map(normalize), mail.subject, mail.text, mail.html ?? null, historyId, folder === "inbox", idempotencyKey ?? null],
    );
    for (const attachment of mail.attachments) {
      await client.query("INSERT INTO attachments (id, message_id, filename, content_type, size, content) VALUES ($1, $2, $3, $4, $5, $6)", [
        randomUUID(), id, attachment.filename, attachment.contentType, attachment.content.length, attachment.content,
      ]);
    }
    if (folder === "inbox") {
      const watches = await client.query<{ url: string }>("SELECT url FROM watches WHERE mailbox = $1 AND expires_at > now()", [mailbox]);
      for (const watch of watches.rows) {
        await this.webhooks.enqueue({ url: watch.url, type: "mail.received", body: { emailAddress: mailbox, historyId } });
      }
    }
    return id;
  }

  // Mail arriving over SMTP or from another LMail mailbox: one copy per local recipient.
  async deliver(mail: IncomingMail, recipients: string[]): Promise<string[]> {
    const local: string[] = [];
    for (const address of recipients) if (await this.isLocal(address)) local.push(normalize(address));
    return inTransaction(this.pool, async (client) => {
      const ids: string[] = [];
      for (const mailbox of new Set(local)) ids.push(await this.file(client, mailbox, "inbox", mail));
      return ids;
    });
  }

  async send(from: string, mail: OutgoingMail, idempotencyKey?: string): Promise<{ id: string; repeated: boolean }> {
    const mailbox = normalize(from);
    if (idempotencyKey) {
      const { rows } = await this.pool.query<{ id: string }>("SELECT id FROM messages WHERE mailbox = $1 AND idempotency_key = $2", [mailbox, idempotencyKey]);
      if (rows[0]) return { id: rows[0].id, repeated: true };
    }
    const { rows: boxes } = await this.pool.query<{ display_name: string }>("SELECT display_name FROM mailboxes WHERE address = $1", [mailbox]);
    if (!boxes[0]) throw new HttpError(404, `LMail has no mailbox ${mailbox}.`);
    const outside: string[] = [];
    for (const address of mail.to) {
      if (await this.isLocal(address)) continue;
      if (await this.hostsDomain(address)) throw new HttpError(422, `LMail has no mailbox ${normalize(address)}.`);
      outside.push(address);
    }
    if (outside.length > 0 && !this.relayUrl) {
      throw new HttpError(422, `LMail cannot reach ${outside.join(", ")}: set LMAIL_RELAY_URL to send outside its own domains.`);
    }
    const domain = mailbox.split("@")[1];
    const message: IncomingMail = {
      messageId: `<${randomUUID()}@${domain}>`,
      inReplyTo: mail.inReplyTo,
      fromAddress: mailbox,
      fromName: boxes[0].display_name,
      to: mail.to.map(normalize),
      subject: mail.subject,
      text: mail.text,
      attachments: mail.attachments ?? [],
    };
    const id = await inTransaction(this.pool, async (client) => {
      const sentId = await this.file(client, mailbox, "sent", message, idempotencyKey);
      for (const address of new Set(message.to)) {
        const { rowCount } = await client.query("SELECT 1 FROM mailboxes WHERE address = $1", [address]);
        if (rowCount === 1) await this.file(client, address, "inbox", message);
      }
      return sentId;
    });
    if (outside.length > 0) {
      const transport = nodemailer.createTransport(this.relayUrl);
      await transport.sendMail({
        from: { name: message.fromName!, address: mailbox },
        to: outside,
        subject: message.subject,
        text: message.text,
        messageId: message.messageId,
        inReplyTo: message.inReplyTo,
        attachments: message.attachments.map((item) => ({ filename: item.filename, contentType: item.contentType, content: item.content })),
      });
    }
    return { id, repeated: false };
  }

  async history(mailbox: string, startHistoryId: string) {
    const { rows: boxes } = await this.pool.query<{ history_id: string }>("SELECT history_id FROM mailboxes WHERE address = $1", [normalize(mailbox)]);
    if (!boxes[0]) throw new HttpError(404, "No such mailbox.");
    const { rows } = await this.pool.query<{ id: string; history_id: string }>(
      "SELECT id, history_id FROM messages WHERE mailbox = $1 AND folder = 'inbox' AND history_id > $2 ORDER BY history_id",
      [normalize(mailbox), startHistoryId],
    );
    return { historyId: boxes[0].history_id, messagesAdded: rows.map((row) => ({ id: row.id, historyId: row.history_id })) };
  }

  // The inbox messages whose sender, subject, text or attachment name holds the words, newest first.
  async search(mailbox: string, text: string) {
    const like = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const { rows } = await this.pool.query<{ id: string; from_address: string; subject: string; received_at: Date }>(
      `SELECT m.id, m.from_address, m.subject, m.received_at FROM messages m
       WHERE m.mailbox = $1 AND m.folder = 'inbox'
         AND (m.subject ILIKE $2 OR m.text_body ILIKE $2 OR m.from_address ILIKE $2
              OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.filename ILIKE $2))
       ORDER BY m.received_at DESC LIMIT 10`,
      [normalize(mailbox), like],
    );
    const files = await this.pool.query<{ id: string; message_id: string; filename: string }>(
      "SELECT id, message_id, filename FROM attachments WHERE message_id = ANY($1) ORDER BY filename",
      [rows.map((row) => row.id)],
    );
    return rows.map((row) => ({
      id: row.id,
      from: row.from_address,
      subject: row.subject,
      receivedAt: row.received_at.toISOString(),
      attachments: files.rows.filter((file) => file.message_id === row.id).map((file) => ({ id: file.id, filename: file.filename })),
    }));
  }

  async list(mailbox: string, folder: string): Promise<MessageSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.folder, m.from_address, m.from_name, m.to_addresses, m.subject, left(m.text_body, 160) AS preview,
              m.unread, m.received_at, (SELECT count(*) FROM attachments a WHERE a.message_id = m.id)::int AS attachment_count
       FROM messages m WHERE m.mailbox = $1 AND m.folder = $2 ORDER BY m.received_at DESC LIMIT 200`,
      [normalize(mailbox), folder],
    );
    return rows.map(summary);
  }

  async get(id: string): Promise<Message | null> {
    const { rows } = await this.pool.query(
      `SELECT m.*, left(m.text_body, 160) AS preview, (SELECT count(*) FROM attachments a WHERE a.message_id = m.id)::int AS attachment_count
       FROM messages m WHERE m.id = $1`,
      [id],
    );
    if (!rows[0]) return null;
    const attachments = await this.pool.query("SELECT id, filename, content_type, size FROM attachments WHERE message_id = $1 ORDER BY filename", [id]);
    const row = rows[0];
    return {
      ...summary(row),
      mailbox: row.mailbox,
      messageId: row.message_id,
      inReplyTo: row.in_reply_to,
      text: row.text_body,
      html: row.html_body,
      historyId: row.history_id,
      attachments: attachments.rows.map((item) => ({ id: item.id, filename: item.filename, contentType: item.content_type, size: item.size })),
    };
  }

  async attachment(messageId: string, attachmentId: string) {
    const { rows } = await this.pool.query<{ filename: string; content_type: string; content: Buffer }>(
      "SELECT filename, content_type, content FROM attachments WHERE id = $1 AND message_id = $2",
      [attachmentId, messageId],
    );
    return rows[0] ?? null;
  }

  async markRead(id: string) {
    await this.pool.query("UPDATE messages SET unread = false WHERE id = $1", [id]);
  }

  async watch(mailbox: string, url: string, client: string) {
    const { rows } = await this.pool.query<{ expires_at: Date; history_id: string }>(
      `INSERT INTO watches (mailbox, url, client, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => ${WATCH_DAYS}))
       ON CONFLICT (mailbox, client) DO UPDATE SET url = excluded.url, expires_at = excluded.expires_at
       RETURNING expires_at, (SELECT history_id FROM mailboxes WHERE address = $1)`,
      [normalize(mailbox), url, client],
    );
    return { historyId: rows[0].history_id, expiration: rows[0].expires_at.toISOString() };
  }

  async mailboxes() {
    const { rows } = await this.pool.query<{ address: string; display_name: string; unread: number }>(
      `SELECT b.address, b.display_name, (SELECT count(*) FROM messages m WHERE m.mailbox = b.address AND m.unread)::int AS unread
       FROM mailboxes b ORDER BY b.address`,
    );
    return rows.map((row) => ({ address: row.address, name: row.display_name, unread: row.unread }));
  }
}

// One database row as the summary the page and the API show.
function summary(row: Record<string, unknown>): MessageSummary {
  return {
    id: String(row.id),
    folder: String(row.folder),
    fromAddress: String(row.from_address),
    fromName: (row.from_name as string | null) ?? null,
    to: row.to_addresses as string[],
    subject: String(row.subject),
    preview: String(row.preview ?? ""),
    unread: Boolean(row.unread),
    receivedAt: (row.received_at as Date).toISOString(),
    attachmentCount: Number(row.attachment_count ?? 0),
  };
}
