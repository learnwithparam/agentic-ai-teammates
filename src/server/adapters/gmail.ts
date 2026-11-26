import type { Pool } from "pg";
import { GMAIL_API, googleClient, startCursor } from "./google";
import { ServiceError } from "./http";
import type { MailFound, MailMessage, MailSource, OutgoingReply } from "./types";

// Gmail, through its REST API, for the one account the refresh token signs in as. It answers the
// same questions as LMail, so the invoice teammate cannot tell which one it reads.
//
// Gmail tells us about new mail through Pub/Sub, not by calling an address we pass. The push
// address is set on the Pub/Sub subscription, so watch() only names the topic.

type Part = { partId?: string; mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { size?: number; data?: string; attachmentId?: string }; parts?: Part[] };
type GmailFull = { id: string; threadId: string; internalDate: string; payload: Part };
type HistoryPage = { history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId: string; nextPageToken?: string };

export class Gmail implements MailSource {
  private readonly api;

  constructor(
    accessToken: () => Promise<string>,
    private readonly pool: Pool,
    // The subscriptions row for this account, such as gmail:bramble.
    private readonly source: string,
    // The Pub/Sub topic Gmail publishes to, as projects/<project>/topics/<topic>.
    private readonly topic: string,
    baseUrl = GMAIL_API,
  ) {
    this.api = googleClient("Gmail", baseUrl, accessToken);
  }

  // Follows every page, as history.list asks, and keeps only mail that landed in the inbox.
  async history(startHistoryId: string) {
    const from = startHistoryId === "0" ? await startCursor(this.pool, this.source, "Gmail") : startHistoryId;
    const ids = new Set<string>();
    let pageToken: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ startHistoryId: from, historyTypes: "messageAdded", labelId: "INBOX" });
      if (pageToken) query.set("pageToken", pageToken);
      const page = await this.api.json<HistoryPage>(`history?${query}`);
      for (const entry of page.history ?? []) {
        for (const added of entry.messagesAdded ?? []) if (added.message.labelIds?.includes("INBOX")) ids.add(added.message.id);
      }
      if (!page.nextPageToken) return { messageIds: [...ids], historyId: page.historyId };
      pageToken = page.nextPageToken;
    }
  }

  async message(id: string): Promise<MailMessage> {
    const full = await this.full(id);
    const header = (name: string) => full.payload.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    const from = parseAddress(header("From"));
    const parts = flatten(full.payload);
    const plain = parts.find((part) => part.mimeType === "text/plain" && !part.filename && part.body?.data);
    const html = parts.find((part) => part.mimeType === "text/html" && !part.filename && part.body?.data);
    return {
      id: full.id,
      messageId: header("Message-ID"),
      from: from.address,
      fromName: from.name,
      subject: header("Subject"),
      text: plain ? decode(plain.body!.data!) : html ? htmlToText(decode(html.body!.data!)) : "",
      receivedAt: new Date(Number(full.internalDate)).toISOString(),
      // The part id names an attachment: Gmail's own attachment ids change on every read.
      attachments: parts
        .filter((part) => part.filename && part.body?.attachmentId)
        .map((part) => ({ id: part.partId!, filename: part.filename!, contentType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0 })),
    };
  }

  // Gmail's own search, in the inbox only. Its words match the sender, subject, text and file names.
  async search(text: string): Promise<MailFound[]> {
    const query = new URLSearchParams({ q: `in:inbox ${text.replace(/["]/g, "")}`, maxResults: "10" });
    const page = await this.api.json<{ messages?: { id: string }[] }>(`messages?${query}`);
    const found: MailFound[] = [];
    for (const { id } of page.messages ?? []) {
      const message = await this.message(id);
      found.push({ id, from: message.from, subject: message.subject, receivedAt: message.receivedAt, attachments: message.attachments.map(({ id: part, filename }) => ({ id: part, filename })) });
    }
    return found;
  }

  async attachment(messageId: string, attachmentId: string) {
    const part = flatten((await this.full(messageId)).payload).find((item) => item.partId === attachmentId && item.body?.attachmentId);
    if (!part) throw new ServiceError("Gmail", 404, "That message has no such attachment.");
    const body = await this.api.json<{ data: string }>(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body!.attachmentId!)}`);
    return { contentType: part.mimeType ?? "application/octet-stream", bytes: new Uint8Array(Buffer.from(body.data, "base64url")) };
  }

  // Gmail takes no idempotency key, so the gateway keeps one. A send whose answer never came
  // may have gone out. It is refused rather than risk a second email to the vendor.
  async send(reply: OutgoingReply, idempotencyKey: string) {
    const threadId = reply.inReplyTo ? await this.threadOf(reply.inReplyTo) : null;
    const started = await this.pool.query("INSERT INTO gmail_sends (idempotency_key) VALUES ($1) ON CONFLICT DO NOTHING", [idempotencyKey]);
    if (started.rowCount === 0) {
      const { rows } = await this.pool.query<{ message_id: string | null }>("SELECT message_id FROM gmail_sends WHERE idempotency_key = $1", [idempotencyKey]);
      if (rows[0]?.message_id) return { id: rows[0].message_id };
      throw new ServiceError("Gmail", 409, "This reply started sending once and its answer never came. Check the Sent folder before sending it again.");
    }
    // With no answer at all, Gmail may have sent it. The row stays, so a retry is refused.
    const response = await this.api.call("messages/send", { method: "POST", body: JSON.stringify({ raw: rawMessage(reply), ...(threadId ? { threadId } : {}) }) });
    if (!response.ok) {
      // Gmail answered no, so nothing went out and a retry may send it.
      await this.pool.query("DELETE FROM gmail_sends WHERE idempotency_key = $1", [idempotencyKey]);
      throw await this.api.failure(response);
    }
    const sent = (await response.json()) as { id: string };
    await this.pool.query("UPDATE gmail_sends SET message_id = $2, sent_at = now() WHERE idempotency_key = $1", [idempotencyKey, sent.id]);
    return { id: sent.id };
  }

  async watch() {
    const answer = await this.api.json<{ historyId: string; expiration: string }>("watch", {
      method: "POST",
      body: JSON.stringify({ topicName: this.topic, labelIds: ["INBOX"], labelFilterBehavior: "include" }),
    });
    return { historyId: answer.historyId, expiration: new Date(Number(answer.expiration)).toISOString() };
  }

  private full(id: string) {
    return this.api.json<GmailFull>(`messages/${encodeURIComponent(id)}?format=full`);
  }

  // The thread of the message we reply to, so the reply sits under it in Gmail.
  private async threadOf(messageId: string): Promise<string | null> {
    const found = await this.api.json<{ messages?: { threadId: string }[] }>(`messages?${new URLSearchParams({ q: `rfc822msgid:${messageId}`, maxResults: "1" })}`);
    return found.messages?.[0]?.threadId ?? null;
  }
}

function flatten(part: Part): Part[] {
  return [part, ...(part.parts ?? []).flatMap(flatten)];
}

function decode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

// A rough plain-text view of an HTML-only mail, enough for the model to read the invoice.
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "Ada Okafor <ada@x.example>" or a bare address, as a name and a lower-case address.
export function parseAddress(value: string): { name: string | null; address: string } {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim() || null, address: match[2].trim().toLowerCase() };
  return { name: null, address: value.trim().toLowerCase() };
}

// A header value with any non-ASCII text in RFC 2047's encoded form.
function headerText(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

// The reply as an RFC 2822 message, in the URL-safe base64 Gmail's send takes.
export function rawMessage(reply: OutgoingReply): string {
  const lines = [
    `To: ${reply.to}`,
    `Subject: ${headerText(reply.subject)}`,
    ...(reply.inReplyTo ? [`In-Reply-To: ${reply.inReplyTo}`, `References: ${reply.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(reply.text, "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
