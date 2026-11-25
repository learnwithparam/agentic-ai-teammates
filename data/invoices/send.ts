import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { requireSettings, setting } from "../../src/server/env";
import { INVOICE_FOLDER } from "../../src/server/teammates/invoice";
import { CASES } from "./cases";
import { fileName } from "./render";

// npm run invoices:send [-- 05-lumen-maths-error ...]
//
// Sends the cases for real: mail cases over SMTP to Bramble's accounts mailbox in LMail, from
// the vendor's own address, and drive cases uploaded to LDrive's Invoices folder. With no case
// named, it sends them all. Nothing here talks to Mission Control: the teammate finds the work
// the way it would in production.

requireSettings(["LMAIL_SMTP_PORT", "LDRIVE_URL", "LDRIVE_UPLOAD_KEY"]);

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), "files");
const named = process.argv.slice(2);
const chosen = named.length ? CASES.filter((invoice) => named.includes(invoice.id)) : CASES;
const unknown = named.filter((id) => !CASES.some((invoice) => invoice.id === id));
if (unknown.length) throw new Error(`There is no case called ${unknown.join(", ")}.`);

const smtp = nodemailer.createTransport({ host: "localhost", port: Number(setting("LMAIL_SMTP_PORT")), secure: false, ignoreTLS: true });
const drive = setting("LDRIVE_URL");
const driveHeaders = { authorization: `Bearer ${setting("LDRIVE_UPLOAD_KEY")}` };

async function invoiceFolderId(): Promise<string> {
  const response = await fetch(`${drive}/api/v1/folders`, { headers: driveHeaders });
  if (!response.ok) throw new Error(`LDrive did not list its folders: ${response.status}.`);
  const folders = (await response.json()) as { id: string; name: string }[];
  const found = folders.find((entry) => entry.name === INVOICE_FOLDER);
  if (!found) throw new Error(`LDrive has no ${INVOICE_FOLDER} folder.`);
  return found.id;
}

const folderId = chosen.some((invoice) => invoice.channel === "drive") ? await invoiceFolderId() : null;

for (const invoice of chosen) {
  const file = path.join(folder, fileName(invoice.id, invoice.channel));
  if (invoice.channel === "drive") {
    const name = `${invoice.vendor.name} ${invoice.number}.pdf`;
    const response = await fetch(`${drive}/api/v1/folders/${folderId}/files?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { ...driveHeaders, "content-type": "application/pdf" },
      body: readFileSync(file),
    });
    if (!response.ok) throw new Error(`LDrive refused ${invoice.id}: ${response.status} ${await response.text()}`);
    console.log(`Uploaded ${invoice.id} to LDrive.`);
    continue;
  }
  const subject = `Invoice ${invoice.number} from ${invoice.vendor.name}`;
  const from = `"${invoice.vendor.name}" <${invoice.from ?? invoice.vendor.email}>`;
  const body = invoice.channel === "mail-body" ? readFileSync(file, "utf8") : `Hello,\n\nPlease find invoice ${invoice.number} attached.\n\n${invoice.vendor.name}`;
  const attachments = invoice.channel === "mail-pdf" ? [{ filename: `${invoice.number}.pdf`, path: file, contentType: "application/pdf" }] : [];
  await smtp.sendMail({ from, to: "ap@bramble.example", subject, text: body, attachments });
  console.log(`Mailed ${invoice.id} to ap@bramble.example.`);
}
smtp.close();
