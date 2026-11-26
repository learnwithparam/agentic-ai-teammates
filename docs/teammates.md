# Define a teammate

A teammate is one folder under `src/server/teammates/` and one name in `registry.ts`. The core reads its definition and wires the rest. No core file changes.

Start one with the scaffolder:

```bash
npm run teammate:new -- late-fees
npm run check
```

It writes a teammate that wakes on a working morning, reads its instructions and stops. The check passes from the start. Then fill in the job, one tested step at a time. The skill in `.claude/skills/new-teammate` walks Claude Code through the same steps.

The Payments teammate in `src/server/teammates/payments` was built this way. Read it next to this page.

## The folder

| File | What it holds |
| --- | --- |
| `teammate.ts` | The definition: every field below. |
| `work.ts` | Turns one batch of inbox events into graph threads. |
| `graph.ts` | The job as a LangGraph graph, one node per step. |
| `attacks.ts` | The attacks only this job faces. |
| `graph.test.ts` | The graph run through a scripted gateway. |
| `data/<kind>/eval.ts` | The score that must hold before anyone turns Quiet off. |

## The teammate's fields

`defineTeammate` in `src/server/teammates/define.ts` takes these fields.

| Field | What it is |
| --- | --- |
| `kind` | The name the code uses, stored on each teammate row. A lowercase word. |
| `id` | The id each company's teammate gets at startup, such as `invoices`. |
| `name` | The name people see on the roster. |
| `purpose` | One sentence the roster shows under the name. |
| `tools` | The only tools the gateway lets this teammate call. Every other tool answers 403. |
| `schedules` | Timers by name and cron, in the company's time zone. |
| `listens` | The webhook sources that wake it: `mail`, `drive`, or none. |
| `defaults` | What a new teammate row starts with. Today that is `dailyBudgetUsd`. |
| `capabilities` | The parts the core supplies, switched on here. See the next table. |
| `evaluate` | The eval script, from the repo root. `npm run teammate:eval -- <kind>` runs it. |
| `attacks` | Its own attacks. `npm run teammate:attack -- <kind>` adds the shared ones. |
| `work` | Builds the function that does one batch of work. |

Startup gives each company one row per teammate. It never overwrites a field a person changed.

## Capabilities

| Field | What the core does |
| --- | --- |
| `chat` | A person can write to it. `mode` is `read` or `act`. `reads` lists the tools it answers from. |
| `followUps` | It may set its own follow-ups with `team.follow_up`. |
| `digest` | It sends the day's summary when the `digest` schedule fires. |
| `tidy` | Once a week it proposes shorter notes, as drafts a person sends or discards. |

`defineTeammate` refuses a definition that does not hold together. A teammate with a digest must list `team.digest` and the `digest` schedule. Every teammate must list `memory.read`, `memory.reported` and `team.remind`.

## The tool's fields

A tool lives in a module under `src/server/tools/`. `defineTool` in `src/server/tools/define.ts` takes these fields.

| Field | What it is |
| --- | --- |
| `description` | What the tool does, in one sentence a model can read. |
| `args` | The zod schema its arguments must parse. |
| `decision` | The policy when no standing rule applies: `allow`, `classify` or `approve`. |
| `readOnly` | True when it only reads. Only a reading tool is offered to a model in a loop. |
| `modelMayCall` | A small write inside the company that a model may call in chat. |
| `judgeRules` | What the quick model reads to judge one call. Without them, a person decides. |
| `ruleReason` | What a person sees when a standing rule asks them to approve every call. |
| `guard` | The tool's own hard checks. It can refuse a call or ask a person. |
| `card` | The approval card a person sees. Every writing tool has one. |
| `run` | The work itself, run once the call is let through. |

Every call goes through `callTool` in the same order. It checks the allowlist, then the arguments, the guard and the policy. Then it claims the approval and runs the tool. A tool cannot skip a step.

## Attack it

`npm run teammate:attack -- <kind>` sends every attack at a teammate on the live stack, with real model calls. Each attack names what must never happen.

- `neverTools` are tools that must never run to the end.
- `stops` are the ways the run may end.
- `refused` means the gateway or the guard must say no.

## Score it

The eval runs real calls and fails when the score does not hold. A new teammate's eval fails until you write one. That is on purpose: it stays Quiet until there is evidence.
