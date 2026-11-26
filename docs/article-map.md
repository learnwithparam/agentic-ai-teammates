# Where the article lives in this repo

[Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) names five primitives. A primitive is one basic part that an always-on agent needs. Each row points at the lesson that builds one part and the file it lives in. A test checks that every file named here exists. It also checks that every lesson and all five primitives are here.

| Primitive | What the article asks for | Lesson | File |
| --- | --- | --- | --- |
| Setup | One stack a learner starts on a laptop | [Start the stack](learner/00-start-the-stack.md) | `infra/docker-compose.yml` |
| Setup | Real apps for the teammates to work in | [Meet the apps your teammates work in](learner/01-meet-the-world.md) | `apps/quirkbooks/main.ts` |
| Inbox | Keep each event until the work is done, and batch fast messages | [Catch every event in a durable inbox](learner/02-catch-every-event.md) | `src/server/inbox.ts` |
| Inbox | Runs, sessions and bounded work | [Bound the agent loop](learner/03-bound-the-agent-loop.md) | `src/server/run.ts` |
| Inbox | Screen untrusted text inside the run | [Read an invoice with a graph you can trace](learner/04-read-an-invoice.md) | `src/server/teammates/screen.ts` |
| Permissions | Plain-code checks the model cannot talk past | [Check every invoice before it posts](learner/05-check-before-you-post.md) | `src/server/checks.ts` |
| Permissions | A credential proxy, a policy per tool, a person for risky calls | [Ask a person before a risky action](learner/06-ask-before-acting.md) | `src/server/gateway-app.ts` |
| Context | Keep the fixed overhead lean and send each call to the right model | [Route each call to the right model](learner/07-route-to-the-right-model.md) | `src/server/router.ts` |
| Timers | Schedules, reminders and follow-ups the agent sets itself | [Follow up on time and remember what people decided](learner/08-remember-and-follow-up.md) | `src/server/timers.ts` |
| Memory | Instructions, an index, what was reported, notes, progress, and a weekly tidy | [Follow up on time and remember what people decided](learner/08-remember-and-follow-up.md) | `src/server/memory.ts` |
| Outbox | Hand work to the outbox, never send inside the run | [Publish the morning news](learner/09-publish-the-morning-news.md) | `src/server/teammates/news/graph.ts` |
| Outbox | Start quiet, pace sends, and earn attention with evals | [Send safely, then score the teammate](learner/10-send-safely-and-score.md) | `src/server/outbox.ts` |
| Setup | Run the same stack on a server | [Deploy the teammates to a server](learner/11-deploy-for-real.md) | `deploy/docker-compose.yml` |
| Permissions | A new job reuses all five, with a person on every payment | [Build a payments teammate from one definition](learner/12-build-a-payments-teammate.md) | `src/server/teammates/payments/teammate.ts` |
| Permissions | Work handed over runs with the access of the person who asked | [Talk to a teammate and hand it work](learner/13-talk-to-a-teammate.md) | `src/server/tools/team.ts` |
