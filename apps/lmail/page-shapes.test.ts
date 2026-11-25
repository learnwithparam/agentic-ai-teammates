import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import * as page from "../../src/client/lmail/api";
import { testDatabase } from "../../src/server/test-database";
import { WebhookSender } from "../shared/webhooks";
import { MailStore } from "./store";

// The LMail page reads the store's answers through its own schemas. A field renamed or made
// nullable on one side fails here, not on a person's screen.

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
let pool: Pool;
let close: () => Promise<void>;
let store: MailStore;

before(async () => {
  ({ pool, close } = await testDatabase(migrations));
  store = new MailStore(pool, new WebhookSender(pool, randomBytes(24).toString("base64")));
});
after(() => close());

test("the page reads mailboxes, both folders and an opened message with its attachment", async () => {
  const [id] = await store.deliver(
    {
      messageId: "<shape-1@harbor.example>",
      fromAddress: "billing@harbor.example",
      to: ["ap@bramble.example"],
      subject: "Invoice HL-1",
      text: "Attached.",
      attachments: [{ filename: "HL-1.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.7") }],
    },
    ["ap@bramble.example"],
  );
  await store.send("ap@bramble.example", { to: ["ada@bramble.example"], subject: "Seen it", text: "Thanks." });

  const boxes = page.Mailboxes.parse(await store.mailboxes());
  assert.equal(boxes.find((box) => box.address === "ap@bramble.example")?.unread, 1);

  const inbox = page.Messages.parse(await store.list("ap@bramble.example", "inbox"));
  assert.equal(inbox[0].fromName, null, "a sender with no display name is null, and the page reads it");
  assert.equal(page.Messages.parse(await store.list("ap@bramble.example", "sent")).length, 1);

  const message = page.Message.parse(await store.get(id));
  assert.equal(message.attachments[0].filename, "HL-1.pdf");
});
