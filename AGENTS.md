# Working in this repository

This repository rebuilds Firstmate as `cardd`, the `fleet` Pi extension, and a board. Read [docs/spec.md](docs/spec.md) for the design and [docs/build-plan.md](docs/build-plan.md) for the build order.

## Commands

- `npm run check` runs every static gate: format, lint, typecheck, knip, dependency-cruiser, and the migration check.
- `npm run test:e2e` builds the board, then runs every end-to-end test. Board tests drive Chromium through playwright, so run `npx playwright install chromium` once.

## Rules

- The gates in `eslint.config.js`, `tsconfig.json`, `knip.json`, and `.dependency-cruiser.cjs` are the rules. Inline disable comments do not work. Change a rule only in its config file, and say why in the pull request.
- Validate data that crosses a process boundary (websocket messages, database rows, environment variables, Pi events) with the schemas in `@fleet/protocol` or a narrowing helper. Trust typed data inside.
- `cardd`, the extension, and the board share only `@fleet/protocol`. End-to-end tests import only `@fleet/protocol`.
- Migrations in `packages/cardd/migrations` are append-only. Add a new numbered file, then run `npm run migrations:check -- --write` to update `schema.sql`.

## Tests

- Tests are end-to-end only. They start real processes (`cardd`, Pi with the scripted fake model in `e2e/support`, and Chromium for the board) and assert what a session or a user sees. Do not write unit tests.
- A behavior change needs an end-to-end test. A bug fix needs a test that fails before the fix.
- Do not wait with fixed sleeps. Wait for an event, an entry, or a state.
- Do not test by reading source files for strings.

## Documents

- `docs/spec.md` is published from the maintainer's working copy. Do not edit it here. Describe a needed spec change in the pull request instead.
- Write documents in short, plain sentences. Do not use em dashes.
