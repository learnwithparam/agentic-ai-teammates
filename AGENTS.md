# agentic-ai-teammates

A public workshop repo: Mission Control, always-on AI teammates on the five primitives (inbox,
timers, memory, permissions, outbox). `main` is the finished app; checkpoint tags hold each lesson.

## Rules

- Production grade only. No mock models, canned answers, stand-ins or "if no key, use X" paths.
  `scripts/check-repo.ts` fails these words in `src/`, `apps/` and `news/src/`.
- `process.env` is read only in `src/server/env.ts`. A missing setting stops the process with
  where to get it.
- Models live in `src/server/models.ts` only; `scripts/check-models.ts` checks them against
  OpenRouter's live list. Never send `temperature` to the strong model. Never show a model name in the UI.
- Permissions live in `infra/openfga/model.fga`; its tests are `infra/openfga/model.fga.yaml`.
- Secrets are written to `.env` by `npm run setup` and never printed or passed on a command line.
- Dependencies are pinned exactly.
- Code passes `scripts/readable.ts`; pages pass `scripts/plain-english.ts`.

## Gate

`npm run check` (also in CI). Done means it passes with zero problems.
