# Build always-on AI teammates

Mission Control is a board of AI teammates that wake on events and work in real tools.
Each one asks a person before it does anything risky.

You build two teammates:

- **The invoice teammate** reads invoices from LMail and LDrive and posts bills to QuirkBooks. When every check tallies, it posts on its own. When one fails, it waits for your approval. For example, an invoice whose bank details differ from the vendor's record never posts on its own.
- **The news teammate** reads RSS feeds, Hacker News and GDELT each morning. Exa joins when you give it a key. It picks the stories that matter to a design studio and publishes them as swipe cards.

The design follows the five parts of [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents): inbox, timers, memory, permissions and outbox.

## What runs

- **Postgres** stores the inbox, timers, outbox and runs.
- **Keycloak** signs people in. Each company is a Keycloak organization.
- **OpenFGA** decides who may see a teammate or decide an approval.
- **MinIO** stores files on your machine. In production you point the same code at R2 or S3.

Nothing here is a stand-in. Every model call is real, and every service is the one you deploy.

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
- **The web process** (http://localhost:8787) takes the apps' signed notices and serves the board.

## Send Bramble some invoices

`data/invoices` holds 15 invoices from Bramble's vendors. Some are clean and some fail a check. One tries to instruct the teammate. [docs/coverage.md](docs/coverage.md) lists what each one proves.

```bash
npm run invoices:send
npm run invoices:send -- 05-lumen-maths-error
```

With no case named, it sends them all. Mail cases go by SMTP to ap@bramble.example. The rest go to LDrive's Invoices folder. Watch the board. Clean invoices post to QuirkBooks by themselves, and the rest wait for you.

After changing `data/invoices/cases.ts`, write the files again with `npm run invoices:make`.

## Read the morning news

The news teammate starts at seven on working mornings. It collects the last two days of stories and drops the ones it published before. Then it picks up to five, reads each article and writes one card per story. Each card links only to a story a source gave that day. The gateway refuses any other link.

To publish the cards, fork this repo and set two values in `.env`:

- `NEWS_REPO` is your fork, as owner/name.
- `GITHUB_TOKEN` is a fine-grained token with Contents read and write on that repo only.

Then turn on Pages in the fork's settings, with GitHub Actions as the source. Each edition is a commit to `news/public/data`, and the News page workflow puts it live. Set `EXA_API_KEY` to add Exa as a source.

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

## Check your work

```bash
npm run check
```

This runs `npm run typecheck`, the tests and the repo checks. It also checks that both models are still live on OpenRouter, then checks and builds the news page.
