import { z } from "zod";

// The shapes that more than one tool, and the teammates that call them, share.

export const Text = z.string().min(1).max(500);
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Card = z.object({
  headline: z.string().min(1).max(90),
  bullets: z.array(z.string().min(1).max(160)).length(3),
  whyItMatters: z.string().min(1).max(220),
  url: z.url(),
  source: z.string().min(1).max(80),
  topic: z.string().min(1).max(40),
});
export type Card = z.infer<typeof Card>;

export const InvoiceSource = z.object({
  kind: z.enum(["mail", "drive"]),
  id: z.string().min(1),
  attachmentId: z.string().nullable(),
  sender: z.string().nullable(),
  subject: z.string().nullable(),
  // The email's Message-ID, so a reply lands in the same conversation.
  messageId: z.string().nullable(),
});
export type InvoiceSource = z.infer<typeof InvoiceSource>;
