# LDrive

LDrive is the shared folders for Bramble Studio. People drop files on its web page.
Programs read its change log, and they hear about new files on a channel.

For example, a vendor's invoice file goes into the Invoices folder. The invoice teammate then hears about it.

## At a glance

| Item | Value |
| --- | --- |
| Web page | http://localhost:8802 |
| Storage | MinIO, through the S3 settings |
| Shared folder | Invoices |
| Sign-in | Keycloak, through the `ldrive` client |
| Code | `apps/ldrive/main.ts`, `apps/ldrive/store.ts` |

## Who may do what

- Any signed-in person sees the folders and downloads files.
- A person uploads a file on the web page.
- Only the uploader or an admin may move a file to the trash.

## Program API

Programs have two keys. Mission Control's key reads. The upload script's key writes. Neither key does the other's job.

| Call | Scope | What it does |
| --- | --- | --- |
| `GET /api/v1/changes/startPageToken` | `drive.read` | Gets the starting point for the change log. |
| `GET /api/v1/changes?pageToken=` | `drive.read` | Lists the changes after a page token. |
| `POST /api/v1/changes/watch` | `drive.read` | Opens a channel that sends notices to an address. |
| `POST /api/v1/channels/:id/stop` | `drive.read` | Stops a channel. |
| `GET /api/v1/files/:id` | `drive.read` | Gets one file's details. |
| `GET /api/v1/files/:id/content` | `drive.read` | Downloads one file. |
| `GET /api/v1/folders` | `drive.write` | Lists the folders. |
| `POST /api/v1/folders/:id/files?name=` | `drive.write` | Uploads a file. The raw request body is the file. |

A channel address must sit under `HOOKS_URL`. Any other address is refused.

## Settings

`npm run setup` writes these names and their values to `.env`. Never paste a value into a chat or a commit.

- `LDRIVE_URL`
- `LDRIVE_PORT`
- `LDRIVE_DATABASE_URL`
- `LDRIVE_API_KEY`
- `LDRIVE_UPLOAD_KEY`
- `LDRIVE_WEBHOOK_SECRET`
- `LDRIVE_CLIENT_SECRET`
- `OIDC_ISSUER`
- `HOOKS_URL`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

Names only. Each one is a line in `.env`.

## Test it

Run the stack first, as in [Start the stack](../../docs/learner/start-the-stack.md). Then run:

```bash
npx tsx --test apps/ldrive/page-shapes.test.ts
```

Expect: the test passes. It checks that the page reads the folders and a folder's files.

## Lessons that use LDrive

- [Meet the apps your teammates work in](../../docs/learner/meet-the-world.md)
- [Read an invoice with a graph you can trace](../../docs/learner/read-an-invoice.md)
- [Deploy the teammates to a server](../../docs/learner/deploy-for-real.md)
