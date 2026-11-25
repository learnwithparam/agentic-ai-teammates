import { z } from "zod";

// What LMail's server answers, read with the same shapes apps/lmail/page-shapes.test.ts checks
// against the real store. A change on one side fails there.

export const Mailboxes = z.array(z.object({ address: z.string(), name: z.string(), unread: z.number() }));
export type Mailbox = z.infer<typeof Mailboxes>[number];

const Summary = z.object({
  id: z.string(),
  folder: z.string(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  to: z.array(z.string()),
  subject: z.string(),
  preview: z.string(),
  unread: z.boolean(),
  receivedAt: z.string(),
  attachmentCount: z.number(),
});
export const Messages = z.array(Summary);
export type MessageSummary = z.infer<typeof Summary>;

const Attachment = z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number() });

export const Message = Summary.extend({
  mailbox: z.string(),
  messageId: z.string(),
  text: z.string(),
  attachments: z.array(Attachment),
});
export type Message = z.infer<typeof Message>;
