# QuirkBooks

QuirkBooks is the books for Bramble Studio. It keeps vendors and purchase orders. It also keeps bills, a double-entry journal and an audit log.
A double-entry journal records each entry on two sides, so the books always balance.

For example, a bill that Mission Control posts shows in the Bills tab. The tab also shows who posted it.

## At a glance

| Item | Value |
| --- | --- |
| Web page | http://localhost:8803 |
| Sign-in | Keycloak, through the `quirkbooks` client |
| Code | `apps/quirkbooks/main.ts`, `apps/quirkbooks/store.ts` |

## Who may do what

- Any signed-in person reads the books.
- Only an admin may change a vendor's bank account.
- Only an admin may mark a bill paid on the web page.

## Program API

Mission Control's key has these scopes. It can read, post and pay bills. It cannot change a vendor's bank account.

| Call | Scope | What it does |
| --- | --- | --- |
| `GET /api/v1/vendors?search=` | `vendors.read` | Lists vendors, with an optional search. |
| `GET /api/v1/purchase-orders/:number` | `pos.read` | Gets one purchase order. |
| `GET /api/v1/bills` | `bills.read` | Lists bills. Filters: `vendorId`, `invoiceNumber`, `dueBy`. |
| `GET /api/v1/bills/:id` | `bills.read` | Gets one bill. |
| `POST /api/v1/bills` | `bills.write` | Posts a bill. The `Idempotency-Key` header is required. |
| `POST /api/v1/bills/:id/pay` | `bills.pay` | Pays a bill. Needs the `Idempotency-Key` header and a `because` reason. |

A post or a payment without its `Idempotency-Key` header fails with 400. The same key gives the first answer again, so a retry never posts or pays twice.

## Settings

`npm run setup` writes these names and their values to `.env`. Never paste a value into a chat or a commit.

- `QUIRKBOOKS_URL`
- `QUIRKBOOKS_PORT`
- `QUIRKBOOKS_DATABASE_URL`
- `QUIRKBOOKS_API_KEY`
- `QUIRKBOOKS_CLIENT_SECRET`
- `OIDC_ISSUER`

## Test it

Run the stack first, as in [Start the stack](../../docs/learner/start-the-stack.md). Then run:

```bash
npx tsx --test apps/quirkbooks/store.test.ts apps/quirkbooks/pay.test.ts apps/quirkbooks/page-shapes.test.ts
```

Expect: every test passes.

The store tests cover posting twice with one key. The pay tests cover a changed bank and paying once.

## Lessons that use QuirkBooks

- [Meet the apps your teammates work in](../../docs/learner/meet-the-world.md)
- [Read an invoice with a graph you can trace](../../docs/learner/read-an-invoice.md)
- [Check every invoice before it posts](../../docs/learner/check-before-you-post.md)
- [Build a payments teammate from one definition](../../docs/learner/build-a-payments-teammate.md)
- [Talk to a teammate and hand it work](../../docs/learner/talk-to-a-teammate.md)
