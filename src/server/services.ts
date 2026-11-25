import type { Pool } from "pg";
import { GoogleDrive } from "./adapters/gdrive";
import { Gmail } from "./adapters/gmail";
import { googleAccessToken } from "./adapters/google";
import { LDrive } from "./adapters/ldrive";
import { LMail } from "./adapters/lmail";
import type { FileSource, MailSource } from "./adapters/types";
import { optionalSetting, requireSettings, setting, type Setting } from "./env";
import type { GoogleHooks } from "./hooks";
import { COMPANIES } from "./people";

// Which mail and file services this deploy reads. The workshop's own LMail and LDrive are the
// choice when nothing is set. Gmail and Google Drive are for a deploy on a real Google account.

export type MailService = "lmail" | "gmail";
export type FileService = "ldrive" | "gdrive";

const GOOGLE: Setting[] = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];
const GMAIL: Setting[] = ["GMAIL_ADDRESS", "GMAIL_PUBSUB_TOPIC", "GMAIL_PUSH_SERVICE_ACCOUNT", "HOOKS_URL"];

export function chosenServices(): { mail: MailService; files: FileService } {
  const mail = optionalSetting("MAIL_SERVICE") ?? "lmail";
  const files = optionalSetting("FILE_SERVICE") ?? "ldrive";
  if (mail !== "lmail" && mail !== "gmail") throw new Error(`MAIL_SERVICE is ${mail}. Use lmail or gmail.`);
  if (files !== "ldrive" && files !== "gdrive") throw new Error(`FILE_SERVICE is ${files}. Use ldrive or gdrive.`);
  // One Google account is one company's mailbox and drive.
  if ((mail === "gmail" || files === "gdrive") && Object.keys(COMPANIES).length > 1) {
    throw new Error("Gmail and Google Drive read one Google account, so they serve one company only.");
  }
  return { mail, files };
}

// The settings the gateway needs for the chosen services.
export function serviceSettings(services: { mail: MailService; files: FileService }): Setting[] {
  return [
    ...(services.mail === "lmail" ? (["LMAIL_URL", "LMAIL_API_KEY"] as Setting[]) : GMAIL),
    ...(services.files === "ldrive" ? (["LDRIVE_URL", "LDRIVE_API_KEY"] as Setting[]) : []),
    ...(services.mail === "gmail" || services.files === "gdrive" ? GOOGLE : []),
  ];
}

// The gateway's mail and file sources, one mailbox per company.
export function openSources(pool: Pool, services: { mail: MailService; files: FileService }) {
  requireSettings(serviceSettings(services));
  const google =
    services.mail === "gmail" || services.files === "gdrive"
      ? googleAccessToken({ clientId: setting("GOOGLE_CLIENT_ID"), clientSecret: setting("GOOGLE_CLIENT_SECRET"), refreshToken: setting("GOOGLE_REFRESH_TOKEN") })
      : null;

  const mailboxes = new Map<string, MailSource>(
    Object.values(COMPANIES).map((company) => [
      company.alias,
      services.mail === "gmail"
        ? new Gmail(google!, pool, `gmail:${company.alias}`, setting("GMAIL_PUBSUB_TOPIC"))
        : new LMail(setting("LMAIL_URL"), setting("LMAIL_API_KEY"), company.accountsMailbox),
    ]),
  );
  const mail = (company: string) => {
    const mailbox = mailboxes.get(company);
    if (!mailbox) throw new Error(`No mailbox for ${company}.`);
    return mailbox;
  };
  const [only] = Object.values(COMPANIES);
  const files: FileSource =
    services.files === "gdrive" ? new GoogleDrive(google!, pool, `gdrive:${only.alias}`) : new LDrive(setting("LDRIVE_URL"), setting("LDRIVE_API_KEY"));
  return { mail, files };
}

// What the web process needs to check Gmail's Pub/Sub notices, or nothing when Gmail is off.
export function googleHooks(services: { mail: MailService }): GoogleHooks | undefined {
  if (services.mail !== "gmail") return undefined;
  requireSettings(["HOOKS_URL", "GMAIL_ADDRESS", "GMAIL_PUSH_SERVICE_ACCOUNT"]);
  return { hooksUrl: setting("HOOKS_URL"), pushServiceAccount: setting("GMAIL_PUSH_SERVICE_ACCOUNT"), mailbox: setting("GMAIL_ADDRESS") };
}
