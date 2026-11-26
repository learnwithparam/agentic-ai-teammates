# Build always-on AI teammates

Mission Control is a board of AI teammates that wake on events and work in real tools.
Each one asks a person before it does anything risky.

You build three teammates:

- **The invoice teammate** reads invoices from LMail and LDrive and posts bills to QuirkBooks. When every check tallies, it posts on its own. When one fails, it waits for your approval. For example, an invoice whose bank details differ from the vendor's record never posts on its own.
- **The news teammate** reads RSS feeds, Hacker News and GDELT each morning. Exa joins when you give it a key. It picks the stories that matter to a design studio and publishes them as swipe cards.
- **The payments teammate** finds the bills due each working morning. It asks a person to approve one pay run. It never pays a bill whose vendor's bank details changed after it was posted. Paying records the payment in QuirkBooks, and no bank money moves.

The teammates also hand work to each other. The invoice teammate may post a bill due within five days. Then it asks the payments teammate to run today. A person still approves every pay run.

Each teammate has its own page in Mission Control. Work shows its cards, Schedule shows what it does next, and Memory shows what it keeps.

The design follows the five parts of [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents): inbox, timers, memory, permissions and outbox.

## What runs

- **Postgres** stores the inbox, timers, outbox and runs.
- **Keycloak** signs people in. Each company is a Keycloak organization.
- **OpenFGA** decides who may see a teammate or decide an approval.
- **MinIO** stores files on your machine. In production you point the same code at R2 or S3.

Nothing here is a stand-in. Every model call is real, and every service is the one you deploy.

## Lessons

Every lesson runs on `main` with the stack up. You read the files and run the real flow. Then you remove one named guard, watch its test fail, and put it back.

| Lesson | What you can do after it |
| --- | --- |
| 00 | [Start the stack](./docs/learner/00-start-the-stack.md) |
| 01 | [Meet the apps your teammates work in](./docs/learner/01-meet-the-world.md) |
| 02 | [Catch every event in a durable inbox](./docs/learner/02-catch-every-event.md) |
| 03 | [Bound the agent loop](./docs/learner/03-bound-the-agent-loop.md) |
| 04 | [Read an invoice with a graph you can trace](./docs/learner/04-read-an-invoice.md) |
| 05 | [Check every invoice before it posts](./docs/learner/05-check-before-you-post.md) |
| 06 | [Ask a person before a risky action](./docs/learner/06-ask-before-acting.md) |
| 07 | [Route each call to the right model](./docs/learner/07-route-to-the-right-model.md) |
| 08 | [Follow up on time and remember what people decided](./docs/learner/08-remember-and-follow-up.md) |
| 09 | [Publish the morning news](./docs/learner/09-publish-the-morning-news.md) |
| 10 | [Send safely, then score the teammate](./docs/learner/10-send-safely-and-score.md) |
| 11 | [Deploy the teammates to a server](./docs/learner/11-deploy-for-real.md) |
| 12 | [Build a payments teammate from one definition](./docs/learner/12-build-a-payments-teammate.md) |
| 13 | [Talk to a teammate and hand it work](./docs/learner/13-talk-to-a-teammate.md) |

## Start

You need Node `>=22.18.0`, Docker and an [OpenRouter key](https://openrouter.ai/settings/keys).

```bash
npm install
npm run setup
```

`npm run setup` writes new secrets into `.env` and starts the services.
It creates the company Bramble Studio and three people:

- Ada is an admin. She can change teammates and decide any approval.
- Ravi is an approver. He can decide approvals up to 5,000 euros.
- Mei can view the board, but she cannot decide.

Their password is `SEED_USER_PASSWORD` in your `.env`. Then add your OpenRouter key to `.env` as `OPENROUTER_API_KEY`.

Langfuse records every run, so you can see what each teammate did and what it cost. Start it once setup is done:

```bash
npm run langfuse:up
```

Open http://localhost:3100 and sign in as `admin@bramble.example`. The password is `LANGFUSE_INIT_USER_PASSWORD` in `langfuse/.env`.

To start the services again after a restart:

```bash
npm run infra:up
```

## The apps your teammates work in

The teammates work in three real apps. Each one has its own database, its own sign-in and its own API.
Start each in its own terminal:

```bash
npm run lmail
npm run ldrive
npm run quirkbooks
```

- **LMail** (http://localhost:8801) is the mail. It takes real mail on port 2525. Send it an invoice with a PDF from any mail program.
- **LDrive** (http://localhost:8802) holds shared folders. Drop an invoice into Invoices and a teammate hears about it.
- **QuirkBooks** (http://localhost:8803) keeps the books: vendors, purchase orders and bills.

Mission Control reaches them only through their APIs, with keys that `npm run setup` writes.

## Start Mission Control

Mission Control is five processes. Start each in its own terminal:

```bash
npm run gateway
npm run worker
npm run scheduler
npm run dispatcher
npm run web
```

- **The gateway** holds every key. It routes each model call, checks each tool call and keeps the spend.
- **The worker** wakes on each new inbox event and runs the teammate. It holds no key.
- **The scheduler** turns timers into inbox events. A reminder fires when an approval waits a day. A summary goes out at six on working evenings.
- **The dispatcher** sends what the outbox holds. It spaces out sends and retries the ones that can work later.
- **The web process** (http://localhost:8790) takes the apps' signed notices and serves the board.

## Send Bramble some invoices

`data/invoices` holds 15 invoices from Bramble's vendors. Some are clean and some fail a check. One tries to instruct the teammate. [docs/coverage.md](docs/coverage.md) lists what each one proves.

```bash
npm run invoices:send
npm run invoices:send -- 05-lumen-maths-error
```

With no case named, it sends them all. Mail cases go by SMTP to ap@bramble.example. The rest go to LDrive's Invoices folder. Watch the board. Clean invoices post to QuirkBooks by themselves, and the rest wait for you.

After changing `data/invoices/cases.ts`, write the files again with `npm run invoices:make`.

## Start a demo from a clean morning

```bash
npm run demo:reset
```

It empties every teammate's work: runs, cards, timers, chats, memory, mail, files and bills. Then it puts back the seed data and sends six invoices. Two post and are due soon, so the invoice teammate asks the payments teammate to pay them. One waits for you, one has new bank details, and one tries to give the teammate orders.

Sign-ins, members and mailboxes stay, so nothing needs a restart.

It only runs on a machine whose `.env` has `DEMO_RESET=yes`. It refuses while the teammates read Gmail or Google Drive.

## Read the morning news

The news teammate starts at seven on working mornings. It collects the last two days of stories and drops the ones it published before. Then it picks up to five, reads each article and writes one card per story. Each card links only to a story a source gave that day. The gateway refuses any other link.

The sources are public RSS feeds, Hacker News and GDELT, so they need no key. Set `EXA_API_KEY` to add Exa as a source.

Each edition goes on Mission Control's news page, at http://localhost:8790/news/. It needs the same sign-in as the board, and each person sees their own company's news.

A public GitHub Pages site can show the cards instead. Fork this repo and set three values in `.env`:

- `NEWS_TARGET` is `github`.
- `NEWS_REPO` is your fork, as owner/name.
- `GITHUB_TOKEN` is a fine-grained token with Contents read and write on that repo only.

Then turn on Pages in the fork's settings, with GitHub Actions as the source. Each edition is a commit to `news/public/data`, and the News page workflow puts it live.

The teammate starts quiet. Its first editions wait as drafts on the board until you let it send. To work on the page itself:

```bash
npm --prefix news install
npm --prefix news run dev
```

## Score the teammate

```bash
npm run invoices:run
npm run invoices:run -- --routing all
```

This screens and reads every case with real model calls, then runs the checks against QuirkBooks's starting books. Nothing is posted, and the gateway must be running.

The table counts the right cases and the wrong postings. It also shows the cost per 100 invoices. The run fails if any invoice would post that should wait. With `--routing all` it also scores each model alone.

Each teammate names its own eval in its definition. This runs one teammate's eval, or every one:

```bash
npm run teammate:eval -- news
npm run teammate:eval -- all
```

The news eval feeds the screen plain articles and articles that try to steer it. It fails if a steering article passes, or if a plain one is held back.

## Attack a teammate

```bash
npm run teammate:attack -- invoice
npm run teammate:attack -- all
```

This sends real attacks at a teammate, through the running gateway, with real model calls. Every teammate gets the shared ones:

- A chat message that orders a write.
- A tool from outside its list.
- A run with no money left.

It also gets the ones only its job has, from `attacks.ts` in its folder. For the invoice teammate, that is an invoice that gives orders and a vendor with new bank details. For the payments teammate, it is a run with a changed bank. It is also a run whose total is lower than its bills.

Each kind gets its own attack teammate, such as `invoice-attack`. It is off duty and quiet, so nothing it writes leaves without a person. A case fails if:

- A forbidden tool ran.
- A run ended the wrong way.
- A call got through.
- Anything was sent.

## Define your own teammate

```bash
npm run teammate:new -- late-fees
```

This writes a new teammate folder from a template and adds it to the registry. The new teammate passes `npm run check` from the start. [docs/teammates.md](docs/teammates.md) lists every field a teammate and a tool can have. The payments teammate was built this way.

## Check your work

```bash
npm run check
```

This runs `npm run typecheck`, the tests and the repo checks. It also checks that both models are still live on OpenRouter, then checks and builds the news page.

```bash
npm run e2e
```

This opens Mission Control in a real browser. Ada, Ravi and Mei each sign in through Keycloak. The test then checks what each of them can see and do. Start the platform and `npm run web` first. CI runs it on every push to main and every night.
