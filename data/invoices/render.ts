import PDFDocument from "pdfkit";
import type { InvoiceCase } from "./cases";

// Draws one invoice the way a small supplier's billing tool would: letterhead, bill-to block,
// a table of lines, totals and payment details. The creation date is fixed, so the same case
// always gives the same bytes and the committed PDFs can be checked against this file.

const FIXED_DATE = new Date("2026-11-25T09:00:00Z");
const BILL_TO = ["Bramble Studio", "Accounts payable", "ap@bramble.example", "Lindenstrasse 4, 10969 Berlin, Germany"];

// Where a case's file is written: a PDF, or text for an invoice sent in the body of an email.
export function fileName(id: string, channel: string): string {
  return `${id}.${channel === "mail-body" ? "txt" : "pdf"}`;
}

export function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

export function renderPdf(invoice: InvoiceCase): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margin: 56, info: { Title: `Invoice ${invoice.number}`, Author: invoice.vendor.name, CreationDate: FIXED_DATE } });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve) => document.on("end", () => resolve(Buffer.concat(chunks))));

  document.font("Helvetica-Bold").fontSize(20).text(invoice.vendor.name);
  document.font("Helvetica").fontSize(9).fillColor("#555").text(invoice.vendor.address).text(invoice.vendor.email);
  document.moveDown(1.5).fillColor("#000").font("Helvetica-Bold").fontSize(16).text("INVOICE");
  document.font("Helvetica").fontSize(10);
  document.text(`Invoice number: ${invoice.number}`);
  document.text(`Invoice date: ${invoice.date}`);
  document.text(`Due date: ${invoice.due}`);
  if (invoice.poNumber) document.text(`Purchase order: ${invoice.poNumber}`);
  document.moveDown().font("Helvetica-Bold").text("Bill to");
  document.font("Helvetica");
  for (const line of BILL_TO) document.text(line);
  if (invoice.note) document.moveDown().font("Helvetica-Oblique").text(invoice.note).font("Helvetica");

  document.moveDown(1.5);
  const left = document.page.margins.left;
  const right = document.page.width - document.page.margins.right;
  const amountColumn = right - 120;
  document.font("Helvetica-Bold").text("Description", left, document.y, { continued: false });
  document.text("Amount", amountColumn, document.y - document.currentLineHeight(), { width: 120, align: "right" });
  document.moveTo(left, document.y + 2).lineTo(right, document.y + 2).stroke();
  document.moveDown(0.5).font("Helvetica");
  for (const line of invoice.lines) {
    const top = document.y;
    document.text(line.description, left, top, { width: amountColumn - left - 12 });
    const bottom = document.y;
    document.text(money(line.amount, invoice.currency), amountColumn, top, { width: 120, align: "right" });
    document.y = Math.max(bottom, document.y);
  }
  const net = invoice.lines.reduce((sum, line) => sum + line.amount, 0);
  document.moveDown();
  for (const [label, amount] of [["Net", net], ["VAT", invoice.tax], ["Total due", invoice.total]] as const) {
    const top = document.y;
    document.font(label === "Total due" ? "Helvetica-Bold" : "Helvetica").text(label, amountColumn - 140, top, { width: 130, align: "right" });
    document.text(money(amount, invoice.currency), amountColumn, top, { width: 120, align: "right" });
  }

  document.moveDown(2).font("Helvetica-Bold").text("Payment", left);
  document.font("Helvetica").text(`Please pay ${money(invoice.total, invoice.currency)} by ${invoice.due} to:`);
  document.text(`Account holder: ${invoice.vendor.name}`);
  document.text(`IBAN: ${invoice.iban}`);
  document.text(`Reference: ${invoice.number}`);
  document.end();
  return finished;
}

// The same invoice written as the body of an email, for a vendor that sends no attachment.
export function renderBody(invoice: InvoiceCase): string {
  const lines = invoice.lines.map((line) => `  ${line.description}: ${money(line.amount, invoice.currency)}`);
  const net = invoice.lines.reduce((sum, line) => sum + line.amount, 0);
  return [
    "Hello Bramble team,",
    "",
    `Here is our invoice ${invoice.number}, dated ${invoice.date}. Payment is due by ${invoice.due}.`,
    "",
    ...lines,
    `  Net: ${money(net, invoice.currency)}`,
    `  VAT: ${money(invoice.tax, invoice.currency)}`,
    `  Total due: ${money(invoice.total, invoice.currency)}`,
    "",
    `Please pay to IBAN ${invoice.iban}, reference ${invoice.number}.`,
    "",
    "Thank you,",
    invoice.vendor.name,
    invoice.vendor.email,
  ].join("\n");
}
