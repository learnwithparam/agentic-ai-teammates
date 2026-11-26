import type { DueBill } from "../payments";
import type { PurchaseOrder, Vendor } from "../checks";

// What a teammate needs from mail, files and the books, whichever service holds them. LMail
// and Gmail both answer MailSource; LDrive and Google Drive both answer FileSource. A company
// picks one of each in its settings. Neither is a stand-in for the other.

export type MailMessage = {
  id: string;
  messageId: string;
  from: string;
  fromName: string | null;
  subject: string;
  text: string;
  receivedAt: string;
  attachments: { id: string; filename: string; contentType: string; size: number }[];
};

export type OutgoingReply = { to: string; subject: string; text: string; inReplyTo: string | null };

export interface MailSource {
  // The messages that arrived after a history id, and the history id to read from next time.
  history(startHistoryId: string): Promise<{ messageIds: string[]; historyId: string }>;
  message(id: string): Promise<MailMessage>;
  attachment(messageId: string, attachmentId: string): Promise<{ contentType: string; bytes: Uint8Array }>;
  // Sends once per key: a retry with the same key never sends twice.
  send(reply: OutgoingReply, idempotencyKey: string): Promise<{ id: string }>;
  // Asks the service to tell hooksAddress about new mail. Returns when the watch runs out.
  watch(hooksAddress: string): Promise<{ historyId: string; expiration: string }>;
}

export type DriveFileInfo = { id: string; name: string; folder: string; contentType: string; size: number; uploadedBy: string };

export interface FileSource {
  startPageToken(): Promise<string>;
  // Files added after a page token, and the token to read from next time.
  changes(pageToken: string): Promise<{ added: DriveFileInfo[]; nextToken: string }>;
  content(fileId: string): Promise<{ file: DriveFileInfo; bytes: Uint8Array }>;
  watch(hooksAddress: string, token: string): Promise<{ channelId: string; expiration: string }>;
  stopWatch(channelId: string): Promise<void>;
}

export type PostedBill = { id: string; vendorId: string; invoiceNumber: string; total: number };
export type BillSummary = { id: string; invoiceNumber: string; invoiceDate: string | null; total: number; currency: string; status: string; postedBecause: string };

export type NewBill = {
  vendorId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  poNumber: string | null;
  currency: string;
  lines: { description: string; amount: number }[];
  tax: number;
  total: number;
  postedBecause: string;
  source: string | null;
};

export interface Accounting {
  findVendor(name: string, email: string | null): Promise<Vendor | null>;
  purchaseOrder(number: string): Promise<PurchaseOrder | null>;
  bills(vendorId: string, invoiceNumber?: string): Promise<BillSummary[]>;
  // Posts once per key. A duplicate invoice comes back as { duplicateOf }.
  postBill(bill: NewBill, idempotencyKey: string): Promise<PostedBill | { duplicateOf: string }>;
  // The open bills due on or before a day, overdue ones included.
  dueBills(dueBy: string): Promise<DueBill[]>;
  bill(id: string): Promise<DueBill | null>;
  // Pays once per key. QuirkBooks's own refusal, such as a changed bank, comes back as { refused }.
  payBill(id: string, idempotencyKey: string, because: string): Promise<{ paidAt: string } | { refused: string }>;
}
