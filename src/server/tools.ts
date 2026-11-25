import { z } from "zod";
import { Invoice } from "./checks";

// Every tool a teammate can ask the gateway for. The teammate sends a name and arguments; the
// gateway checks the arguments, applies the policy, and runs the tool with its own keys.
//
// The policy for each tool, unless a person set a standing rule for it:
//   allow     runs at once. Reading is always allowed.
//   classify  the quick model judges whether this one call is safe and in scope; if not, a person decides.
//   approve   a person decides every time.

export type Decision = "allow" | "classify" | "approve";

export type ToolDefinition = {
  description: string;
  args: z.ZodType;
  decision: Decision;
  // A read-only tool may be offered to a model in an open-ended loop. A writing tool never is.
  readOnly: boolean;
};

const Text = z.string().min(1).max(500);

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

export const TOOLS = {
  "mail.history": {
    description: "List the messages that arrived in the accounts mailbox after a history id.",
    args: z.object({ startHistoryId: z.string().regex(/^\d+$/) }),
    decision: "allow",
    readOnly: true,
  },
  "mail.message": {
    description: "Read one email: sender, subject, body text and attachment names.",
    args: z.object({ id: Text }),
    decision: "allow",
    readOnly: true,
  },
  "mail.attachment_text": {
    description: "Read the text of a PDF attached to an email.",
    args: z.object({ messageId: Text, attachmentId: Text }),
    decision: "allow",
    readOnly: true,
  },
  "drive.changes": {
    description: "List the files added to the shared drive after a page token.",
    args: z.object({ pageToken: z.string().regex(/^\d+$/) }),
    decision: "allow",
    readOnly: true,
  },
  "drive.file_text": {
    description: "Read the text of a PDF in the shared drive.",
    args: z.object({ fileId: Text }),
    decision: "allow",
    readOnly: true,
  },
  "books.find_vendor": {
    description: "Find a vendor in QuirkBooks by name or email address.",
    args: z.object({ name: Text, email: z.string().max(200).nullable() }),
    decision: "allow",
    readOnly: true,
  },
  "books.purchase_order": {
    description: "Read one purchase order by its number, such as PO-1042.",
    args: z.object({ number: Text }),
    decision: "allow",
    readOnly: true,
  },
  "books.vendor_bills": {
    description: "List the bills QuirkBooks already has from one vendor, newest first.",
    args: z.object({ vendorId: Text }),
    decision: "allow",
    readOnly: true,
  },
  "books.post_bill": {
    description: "Post an invoice to QuirkBooks as a bill.",
    args: z.object({ invoice: Invoice, source: InvoiceSource, brief: z.string().min(1).max(1500).nullable() }),
    // The gateway decides this one itself: it runs the invoice checks again and posts only when
    // every check passes and the total is within the teammate's limit. Otherwise a person decides.
    decision: "allow",
    readOnly: false,
  },
  "mail.reply": {
    description: "Reply to an email from the accounts mailbox.",
    args: z.object({
      to: z.email(),
      subject: z.string().min(1).max(200),
      text: z.string().min(1).max(4000),
      inReplyTo: z.string().nullable(),
    }),
    decision: "classify",
    readOnly: false,
  },
  "news.publish": {
    description: "Publish the day's news cards.",
    args: z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      cards: z.array(Card).min(1).max(10),
    }),
    decision: "allow",
    readOnly: false,
  },
} satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof TOOLS;
export type ToolArgs<Name extends ToolName> = z.infer<(typeof TOOLS)[Name]["args"]>;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}

// The tool as a model sees it in an open-ended loop. Dots are not allowed in a function name.
export function modelToolSpec(name: ToolName) {
  const tool: ToolDefinition = TOOLS[name];
  if (!tool.readOnly) throw new Error(`${name} writes, so it is never offered to a model.`);
  return {
    type: "function" as const,
    function: { name: name.replace(".", "__"), description: tool.description, parameters: z.toJSONSchema(tool.args) as Record<string, unknown> },
  };
}

export function toolFromModelName(name: string): ToolName | null {
  const tool = name.replace("__", ".");
  return isToolName(tool) ? tool : null;
}

// What a tool call returned to the teammate.
export type ToolResult =
  | { status: "done"; result: unknown }
  | { status: "needs_approval"; approvalId: string; reasons: string[] }
  | { status: "denied"; reason: string };
