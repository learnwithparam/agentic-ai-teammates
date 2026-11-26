# LMail

LMail is the mail for Bramble Studio and its vendors. People read and write mail on its web page.
Mission Control reads and sends mail through its API, with a key.

For example, the invoice teammate reads a vendor's invoice email here. Then it posts the bill to QuirkBooks.

## At a glance

| Item | Value |
| --- | --- |
| Web page | http://localhost:8801 |
| Real mail | SMTP on port 2525 |
| Shared mailbox | `ap@bramble.example`, the accounts payable mailbox |
| Sign-in | Keycloak, through the `lmail` client |
| Code | `apps/lmail/main.ts`, `apps/lmail/store.ts`, `apps/lmail/smtp.ts` |

## Who may open what

- Each person opens their own mailbox.
- Each person also opens their company's shared accounts payable mailbox.
- An admin opens every mailbox, including the vendors'.
- Mission Control's key may use only `ap@bramble.example`.

## Program API

A program calls the API with a key. The key must have the scope that the call needs.

| Call | Scope | What it does |
| --- | --- | --- |
| `GET /api/v1/mailboxes/:address/history` | `mail.read` | Lists changes since a history number. |
| `GET /api/v1/mailboxes/:address/search?q=` | `mail.read` | Finds mail by text. |
| `GET /api/v1/messages/:id` | `mail.read` | Gets one message. |
| `GET /api/v1/messages/:id/attachments/:attachmentId` | `mail.read` | Gets one attachment. |
| `POST /api/v1/mailboxes/:address/watch` | `mail.read` | Sends notices to a web address when mail arrives. |
| `POST /api/v1/mailboxes/:address/send` | `mail.send` | Sends a mail. The `Idempotency-Key` header is required. |

Without the `Idempotency-Key` header, a send fails with 400. The key makes a retry send once.

## Settings

`npm run setup` writes these names and their values to `.env`. Never paste a value into a chat or a commit.

Required:

- `LMAIL_URL`
- `LMAIL_PORT`
- `LMAIL_SMTP_PORT`
- `LMAIL_DATABASE_URL`
- `LMAIL_API_KEY`
- `LMAIL_WEBHOOK_SECRET`
- `LMAIL_CLIENT_SECRET`
- `OIDC_ISSUER`
- `HOOKS_URL`
- Optional: `LMAIL_RELAY_URL`, an SMTP relay for sending outside LMail's own domains.

## Test it

Run the stack first, as in [Start the stack](../../docs/learner/start-the-stack.md). Then run:

```bash
npx tsx --test apps/lmail/store.test.ts apps/lmail/page-shapes.test.ts
```

Expect: every test passes.

The store tests cover the watch address and search. The page test covers mailboxes, folders and attachments.

## Lessons that use LMail

- [Meet the apps your teammates work in](../../docs/learner/meet-the-world.md)
- [Catch every event in a durable inbox](../../docs/learner/catch-every-event.md)
- [Read an invoice with a graph you can trace](../../docs/learner/read-an-invoice.md)
- [Send safely, then score the teammate](../../docs/learner/send-safely-and-score.md)
- [Deploy the teammates to a server](../../docs/learner/deploy-for-real.md)
