# 12 Build a payments teammate from one definition

## Why

The article's teammates share one core: an inbox, timers, memory, permissions and an outbox. A new teammate should reuse all five and add only its job. If each new job means changes across the core, every teammate can break the others.

Paying bills is the riskiest job yet. Money leaves the company. A fraudster who changes a vendor's bank details only has to wait for the next pay run.

## Goal

You read how the payments teammate is defined in one folder. You run a pay run, approve it, and see two bills paid in QuirkBooks. The bill whose bank changed is held back.

## Starting point

The stack is running and you can sign in to Mission Control as Ada. QuirkBooks has three open bills to pay. Harbor Lane's rent and Copperleaf's catering fall due this week, and Pixelforge's licence is overdue. Copperleaf's bank details changed after its bill posted.

## How it works

A teammate is one folder under `src/server/teammates/` and one name in `registry.ts`. The definition in `payments/teammate.ts` says everything the core needs:

| Field | For payments |
| --- | --- |
| `tools` | `books.due_bills`, `books.pay_bill`, and the memory and team tools every teammate lists. |
| `schedules` | The pay run at nine on working mornings, and the evening digest. |
| `capabilities` | Chat that reads the due bills. No follow-ups. A digest. |
| `evaluate` | `data/payments/eval.ts`, which scores the checks against the live books. |
| `attacks` | A run with a changed bank, and a run whose total is lower than its bills. |

The gateway lets the teammate call only those tools. The scheduler gives it only those timers. `docs/teammates.md` lists every field.

The pay run is a graph in `payments/graph.ts`. It calls no model. The books know which bills are due and which bank each was posted with. They also know the total. So plain code decides.

There are three walls, each from facts the model never gives:

1. The graph checks each bill with `payProblems` and holds back the ones that fail.
2. The gateway's guard on `books.pay_bill` reads every bill again. It refuses a run whose total is not the books' own sum. That total is the amount on the approval card. So a person's approval limit is checked against the true sum.
3. QuirkBooks itself refuses to pay a bill whose vendor's bank changed after it posted.

```mermaid
sequenceDiagram
  participant Graph as pay run graph
  participant Gateway
  participant Ada
  participant Books as QuirkBooks
  Graph->>Gateway: books.due_bills
  Gateway-->>Graph: three bills
  Graph->>Graph: Copperleaf's bank changed, held back
  Graph->>Gateway: books.pay_bill, two bills, 2,088.00 EUR
  alt the total is not the books' sum
    Gateway-->>Graph: denied, the bills add up to another total
  else every bill checks out
    Gateway-->>Graph: waits for a person
    Ada->>Gateway: approve, within her limit
    Gateway->>Books: pay each bill, one key per bill
    Books-->>Gateway: paid
  end
```

### Two teammates working together

A bill can fall due before the next pay run. So the invoice teammate checks each bill it posts. If one falls due within five days, it asks the payments teammate to run today. It calls `team.ask_teammate`, and the ask lands in Payments' inbox as a `teammate.request` event.

Two lists must agree before an ask goes through. The invoice teammate lists `team.ask_teammate` in its tools. The payments teammate names `invoice` in `takesAsksFrom`. If either list is missing, the gateway refuses the ask.

The ask moves no money. Payments starts the day's pay run, checks every bill again, and a person still approves the card. Paying records the payment in QuirkBooks. No bank money moves in this workshop.

![The pay run card after the invoice teammate's ask](../images/mc-pay-run.png)

## Run it

The pay run fires at nine on working mornings. To start it now, move its timer:

```bash
docker exec teammates-platform-postgres-1 \
  psql -U teammates -d teammates -c "UPDATE timers SET fire_at = now() WHERE teammate = 'payments' AND name = 'pay-run'"
```

The payments card on the board moves to Waiting. Open the approval: it lists every open bill due within five days.

On a fresh stack that is two bills, 2,088.00 EUR. Bills you posted in earlier lessons join the run if they fall due in that window. Approve it as Ada.

Open QuirkBooks at http://localhost:8803 and look at the bills. Harbor Lane's rent and the Pixelforge licence are paid. Copperleaf is still open. The audit log has one `bill.paid` line per bill, with the reason Ada approved.

Now attack it:

```bash
npm run teammate:attack -- payments
npm run teammate:eval -- payments
```

Both pass. The eval never pays: every run it sends is one the gateway must refuse.

To start a teammate of your own, write it from the template:

```bash
npm run teammate:new -- late-fees
npm run check
```

The check passes before you change anything. The skill in `.claude/skills/new-teammate` walks Claude Code through the rest.

## Break it

The guard's sum check keeps the card honest. Without it, a small number on the card could slip a large run past a person's limit.

1. Open `src/server/tools/books.ts` and find `if (sum !== args.total) return { deny` in the guard of `books.pay_bill`.
2. Delete that line.
3. Run `npx tsx --test src/server/gateway-app.test.ts`. This test in `src/server/gateway-app.test.ts` fails:

   ```text
   "a pay run is refused unless every bill may be paid and the total is the books' own sum"
   ```

4. Put it back. It passes.

The hand-off has its own guard: the two lists must agree.

1. Open `src/server/teammates/invoice/teammate.ts` and find `"team.ask_teammate",` in its tools.
2. Delete that line.
3. Run `npx tsx --test src/server/teammates/registry.test.ts`. This test in `src/server/teammates/registry.test.ts` fails:

   ```text
   "every kind a teammate takes asks from exists and may ask, and every teammate that asks has someone to ask"
   ```

4. Put it back. It passes.

## What you have now

- A third teammate that touches no core file: one folder and one line in the registry.
- A pay run checked three times from the books' own facts, and approved by a person every time.
- A template and a skill that start the next teammate with a passing check.
