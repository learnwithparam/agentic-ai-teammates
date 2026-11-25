# 05 Check every invoice before it posts

## Why

A model reads an invoice well, but it should not decide whether to pay it.
A company often loses money the same few ways. A bank account changes, a total is wrong, or an invoice comes twice.
Each of those is a fact you can check in code, every time, with no model involved.

## Goal

A clean invoice posts with no click, and each kind of bad invoice waits with its reason.

## Starting point

The stack is running, and you have seen one invoice go through in lesson 04.

## How it works

`checkInvoice` in `src/server/checks.ts` is a plain function.
It takes the extracted invoice and the facts QuirkBooks holds, and returns a list of reasons:

- `arithmetic`: the lines and tax do not add up to the total.
- `unknown_vendor`: QuirkBooks has no vendor with this name or email.
- `sender_unknown`: the mail did not come from the vendor's address.
- `bank_changed`: the bank account is not the one on file.
- `duplicate`: this vendor already has a bill with this number.
- `po_missing`: the vendor needs a purchase order, and the invoice names none.
- `po_mismatch`: the purchase order is closed or belongs to another vendor.
- `po_over_tolerance`: the total is more than 5 percent over the purchase order.
- `currency`: the invoice is not in the currency of the books or the vendor.
- `over_limit`: the total is above what may post without a person.

No reasons means the graph goes straight to `post`.
The gateway runs the checks again just before it posts. So a confused run still cannot post a bad bill.

```mermaid
sequenceDiagram
  participant Graph as invoice graph
  participant Books as QuirkBooks
  participant Checks as checks.ts
  participant Gateway
  Graph->>Books: vendor, purchase order, past bills
  Graph->>Checks: invoice plus those facts
  alt no reasons
    Checks-->>Graph: none
    Graph->>Gateway: post the bill
    Gateway->>Checks: check again
    Gateway->>Books: POST /bills with an Idempotency-Key
  else one or more reasons
    Checks-->>Graph: bank_changed
    Graph-->>Graph: held: investigate, write a brief, wait for a person
  end
```

## Run it

Send a clean invoice and two bad ones:

```bash
npm run invoices:send -- 01-northwind-paper
npm run invoices:send -- 07-kestrel-new-bank
npm run invoices:send -- 11-lumen-over-po
```

The clean one lands in Done, and its bill is in QuirkBooks.
The other two wait in Needs approval, each with its reason on the card.

![The board with posted and held invoices](../images/board.png)

## Break it

A purchase order allows 5 percent over. A cent more must not pass.

1. Open `src/server/checks.ts` and find the `po_over_tolerance` line.
2. Change `po.amount * (1 + rules.poTolerance)` to `po.amount + rules.poTolerance`. Now the allowance is 5 cents, not 5 percent.
3. Run `npx tsx --test src/server/checks.test.ts`. This test in `src/server/checks.test.ts` fails:

   ```text
   "five percent over the purchase order still passes, a cent more does not"
   ```

4. Put it back. It passes.

## What you have now

- Ten reasons to hold an invoice, each one plain code with its own test.
- Clean invoices that post themselves.
- A second check in the gateway, right before the money moves.
