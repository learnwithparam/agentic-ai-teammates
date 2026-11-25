# Build always-on AI teammates

Mission Control is a board of AI teammates that wake on events and work in real tools.
Each one asks a person before it does anything risky.

You build two teammates:

- **The invoice teammate** reads invoices from LMail and LDrive and posts bills to QuirkBooks. When every check tallies, it posts on its own. When one fails, it waits for your approval. For example, an invoice whose bank details differ from the vendor's record never posts on its own.
- **The news teammate** reads RSS, Hacker News and GDELT each morning. It picks the best stories and publishes them as swipe cards.

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

To start the services again after a restart:

```bash
npm run infra:up
```

## Check your work

```bash
npm run check
```

This runs `npm run typecheck`, the tests and the repo checks. It also checks that both models are still live on OpenRouter.
