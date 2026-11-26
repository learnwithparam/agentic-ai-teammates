---
name: new-teammate
description: Create a new always-on teammate in this repo from its job, with its tools, graph, attacks and eval. Use when asked to add, build or define a teammate.
---

# Make a new teammate

A teammate is one folder and one line in the registry. Read `docs/teammates.md` for every field. Read `src/server/teammates/payments` as the worked example.

## 1. Ask about the job

Get a plain answer to each question before writing code.

- What wakes it? A schedule, new mail, a new file, or a person in chat.
- What does it read, and from which app?
- What does it write, and which writes are risky? Money, mail to outsiders and anything public are risky.
- What can plain code check from the facts in the apps? A model only judges what code cannot.
- How would someone try to misuse it?

## 2. Write the folder

```bash
npm run teammate:new -- <kind>
npm run check
```

The check passes before you change anything.

## 3. Fill in the job

- Add a tool module under `src/server/tools/` for each new read or write. A risky write uses `decision: "approve"` and a `card`.
- Put the hard checks in the tool's `guard`, from facts the gateway reads itself. Never trust a total or an id the model gives.
- List every tool in the definition's `tools`. The gateway refuses any other.
- Write the graph one node at a time. Each node gets a test in `graph.test.ts`.

## 4. Write the attacks

Replace the template's attack in `attacks.ts` with the ways someone would misuse this job. A call attack must expect a refusal.

## 5. Write the eval

Replace `data/<kind>/eval.ts` with cases that score the job with real calls. It must never send anything a person has not approved.

## 6. Prove it

```bash
npm run check
npm run teammate:attack -- <kind>
npm run teammate:eval -- <kind>
```

All three must pass. Then remove one guard and watch its test fail, and put it back.
