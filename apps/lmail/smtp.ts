import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { type MailStore, normalize } from "./store";

// LMail's front door for mail: a real SMTP server, so any mail client or swaks can send it an
// invoice with a PDF. It takes mail only for mailboxes it has, like any domain's mail server.

const MAX_BYTES = 15 * 1024 * 1024;

export function startSmtp(store: MailStore, port: number) {
  const server = new SMTPServer({
    name: "lmail.local",
    banner: "LMail",
    // An inbound mail server: senders do not sign in, and TLS ends at the proxy in front of it.
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    size: MAX_BYTES,
    onRcptTo(address, _session, callback) {
      store
        .isLocal(address.address)
        .then((local) => callback(local ? undefined : Object.assign(new Error(`No mailbox ${address.address} here`), { responseCode: 550 })))
        .catch((error) => callback(error));
    },
    onData(stream, session, callback) {
      simpleParser(stream)
        .then(async (parsed) => {
          if ((stream as { sizeExceeded?: boolean }).sizeExceeded) throw Object.assign(new Error("Message too large"), { responseCode: 552 });
          const from = parsed.from?.value[0];
          await store.deliver(
            {
              messageId: parsed.messageId ?? `<${Date.now()}@lmail.local>`,
              inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : undefined,
              fromAddress: normalize(from?.address ?? (session.envelope.mailFrom ? session.envelope.mailFrom.address : "unknown@unknown")),
              fromName: from?.name || undefined,
              to: session.envelope.rcptTo.map((item) => item.address),
              subject: parsed.subject ?? "",
              text: parsed.text ?? "",
              html: typeof parsed.html === "string" ? parsed.html : undefined,
              attachments: parsed.attachments.map((item) => ({
                filename: item.filename ?? "attachment",
                contentType: item.contentType,
                content: item.content,
              })),
            },
            session.envelope.rcptTo.map((item) => item.address),
          );
          callback();
        })
        .catch((error) => callback(error));
    },
  });
  server.on("error", (error) => console.error("smtp:", error.message));
  server.listen(port, () => console.log(`LMail SMTP listening on port ${port}`));
  return server;
}
