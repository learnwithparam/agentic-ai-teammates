# 10 Send safely, then score the teammate

## Why

A teammate's last step is to talk to the outside world. It replies to a vendor, or puts a page on the web.
If it sends inside the run, a crash after sending makes it send again. A burst of runs floods one inbox.
And before you let a teammate send on its own, you want numbers that say it is right.

## Goal

You release a quiet teammate's draft and see the dispatcher pace and retry. Then you run the invoice scoreboard.

## Starting point

The stack is running. The news edition from lesson 09 went through the outbox.

## How it works

A run never sends anything. Its tools write a row to the outbox, in `src/server/outbox.ts`. The dispatcher sends rows one at a time:

- **Quiet first.** A new teammate is quiet. Its messages wait as drafts until a person sends or discards them. Turn quiet off in Settings once you trust it.
- **Pacing.** At most one send per target every 2 seconds. The pacing row is locked with the message, so two dispatchers cannot both send.
- **Retries.** A failure a retry can fix waits 20 seconds, then twice as long each time. It stops after 6 attempts. One it cannot fix is dead at once, with its reason.
- **Idempotency.** Every message carries a key, so a resend after a crash is the same send.

Turning quiet off is a decision you make from evidence.

Settings shows the last 14 days. It counts what the teammate sent on its own, and what people released or discarded. It also counts what still waits. Each teammate also has an eval, run with `npm run teammate:eval -- <kind>`. Its score must hold before quiet goes off.

```mermaid
sequenceDiagram
  participant Run
  participant Outbox
  participant Person
  participant Dispatcher
  participant LMail
  Run->>Outbox: mail.reply, quiet teammate
  Outbox-->>Run: saved as a draft
  Dispatcher->>Outbox: claim the next queued message
  Outbox-->>Dispatcher: nothing, a draft waits for a person
  Person->>Outbox: send
  Dispatcher->>Outbox: claim, lock the target's pacing
  Dispatcher->>LMail: send with its idempotency key
  alt LMail answers 503
    LMail-->>Dispatcher: 503
    Dispatcher->>Outbox: retry in 20 seconds
  else it sends
    LMail-->>Dispatcher: sent
    Dispatcher->>Outbox: sent
  end
```

## Run it

Open Activity. The outbox table shows every message a teammate wrote and what became of it. "Waiting for you" is a draft.

![The outbox table](../images/mc-activity.png)

Now score the invoice teammate on all fifteen cases, with real model calls:

```bash
npm run invoices:run
```

It sends every case, waits for each run to finish, and compares the result with what `data/invoices/cases.ts` expects.
Two numbers matter. Wrong postings must be zero. Every clean invoice must post with no click.
`docs/coverage.md` maps each case to the promise it proves.

## Break it

A draft is a promise that nothing goes out until a person says so.

1. Open `src/server/outbox.ts` and find `message.status = 'queued'` in `claim`.
2. Change it to `message.status IN ('queued', 'draft')`.
3. Run `npx tsx --test src/server/dispatcher-loop.test.ts`. This test in `src/server/dispatcher-loop.test.ts` fails:

   ```text
   "a draft is never sent until a person releases it"
   ```

4. Put it back. It passes.

## What you have now

- Every send in one table, paced, retried and keyed.
- A teammate that starts quiet and earns the right to send.
- A scoreboard that proves zero wrong postings before you trust it.
