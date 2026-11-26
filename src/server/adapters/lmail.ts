import type { MailFound, MailMessage, MailSource, OutgoingReply } from "./types";
import { serviceClient } from "./http";

// LMail, through its program API, for one mailbox: the company's accounts address.

type LMailMessage = MailMessage & { fromAddress: string };

export class LMail implements MailSource {
  private readonly service;

  constructor(
    baseUrl: string,
    apiKey: string,
    private readonly mailbox: string,
  ) {
    this.service = serviceClient("LMail", baseUrl, apiKey);
  }

  private get box() {
    return `/api/v1/mailboxes/${encodeURIComponent(this.mailbox)}`;
  }

  async history(startHistoryId: string) {
    const page = await this.service.json<{ historyId: string; messagesAdded: { id: string }[] }>(
      `${this.box}/history?startHistoryId=${encodeURIComponent(startHistoryId)}`,
    );
    return { messageIds: page.messagesAdded.map((message) => message.id), historyId: page.historyId };
  }

  async message(id: string): Promise<MailMessage> {
    const message = await this.service.json<LMailMessage>(`/api/v1/messages/${encodeURIComponent(id)}`);
    const { messageId, fromName, subject, text, receivedAt, attachments } = message;
    return { id: message.id, messageId, from: message.fromAddress, fromName, subject, text, receivedAt, attachments };
  }

  search(text: string) {
    return this.service.json<MailFound[]>(`${this.box}/search?q=${encodeURIComponent(text)}`);
  }

  attachment(messageId: string, attachmentId: string) {
    return this.service.bytes(`/api/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  }

  async send(reply: OutgoingReply, idempotencyKey: string) {
    const body = JSON.stringify({ to: [reply.to], subject: reply.subject, text: reply.text, ...(reply.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}) });
    const sent = await this.service.json<{ id: string }>(`${this.box}/send`, { method: "POST", body, headers: { "Idempotency-Key": idempotencyKey } });
    return { id: sent.id };
  }

  watch(hooksAddress: string) {
    return this.service.json<{ historyId: string; expiration: string }>(`${this.box}/watch`, { method: "POST", body: JSON.stringify({ url: hooksAddress }) });
  }
}
