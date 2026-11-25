import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases";
import { fileName, renderBody, renderPdf } from "./render";

// npm run invoices:make
//
// Writes each case to data/invoices/files: a PDF for mail attachments and drive uploads, a
// text file for an invoice sent as the body of an email. The files are committed, and
// coverage.test.ts fails if one no longer matches what this script would write.

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), "files");

for (const invoice of CASES) {
  const content = invoice.channel === "mail-body" ? renderBody(invoice) : await renderPdf(invoice);
  writeFileSync(path.join(folder, fileName(invoice.id, invoice.channel)), content);
}
console.log(`Wrote ${CASES.length} invoices to data/invoices/files.`);
