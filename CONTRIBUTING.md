# Contributing to fleet

This repository is Firstmate, rebuilt: `cardd`, the `fleet` Pi extension, and a board. Its `AGENTS.md` is the job description of the mates, which run in checkouts of it. As a worker in this repository, follow your worker role contract and this guide, not `AGENTS.md`.

Read [docs/spec.md](docs/spec.md) for the design and [docs/build-plan.md](docs/build-plan.md) for the build order.

## Commands

- `npm run check` runs every static gate: format, lint, typecheck, knip, dependency-cruiser, and the migration check. Run it for every change.
- Locally, run only the end-to-end files that your change touches or adds: `npm run build`, then `node e2e/run.ts <file>...`. The runner gives each file its own run folder and herdr sessions, runs files in parallel (one file per 16 cores by default, with a minimum of one and a cap of eight; set `FLEET_E2E_CONCURRENCY` to an integer from one through that default to run fewer), and checks that its registered process groups are gone before returning. Detached test helpers must register before executing their commands. Two runs from two worktrees on one host do not touch each other. Board tests drive Chromium through playwright, so run `npx playwright install chromium` once.
- `npm ci` installs a pre-push hook: the `prepare` script points `core.hooksPath` at `.githooks`. On `git push` the hook runs format, lint, and typecheck on the files your branch changed, in a few seconds. Fix what it reports and push again. `git push --no-verify` skips it, and then CI is the only check. [docs/code.md](docs/code.md) says how it works.
- CI owns the full end-to-end suite. On a pull request, CI runs the suites that its paths select (`.github/workflows/ci.yml`), and `ci-ok` gates the merge. A change that never reaches CI (local-only delivery) runs `npm run test:e2e` before it lands, which builds the board and then runs every end-to-end test in parallel.

## Rules

- The gates in `.oxlintrc.json`, `lint-plugin.js`, `tsconfig.json`, `knip.json`, and `.dependency-cruiser.cjs` are the rules. Inline disable comments do not work. Change a rule only in its config file, and say why in the pull request.
- No comments in code. The `fleet/no-comments` lint rule fails on any comment. Say it with a name, a type, or a smaller function. A reason that no name can carry goes in [docs/code.md](docs/code.md).
- Validate data that crosses a process boundary (websocket messages, database rows, environment variables, Pi events) with the schemas in `@fleet/protocol` or a narrowing helper. Trust typed data inside.
- `cardd`, the extension, and the board share only `@fleet/protocol`. End-to-end tests import only `@fleet/protocol`.
- Migrations in `packages/cardd/migrations` are append-only. Add a new numbered file, then run `npm run migrations:check -- --write` to update `schema.sql`.

## Tests

- Tests are end-to-end only. They start real processes (`cardd`, Pi with the scripted fake model in `e2e/support`, and Chromium for the board) and assert what a session or a user sees. Do not write unit tests.
- A behavior change needs an end-to-end test. A bug fix needs a test that fails before the fix.
- Do not wait with fixed sleeps. Wait for an event, an entry, or a state.
- Do not test by reading source files for strings.
- A test or a helper stops only what it started itself: its own lab session by its own `--session` name (`HerdrLab` does this), or its own process by pid or process group. It never kills a process by name. One host runs the live herdr server, the lanes, and other workers' tests, so `pkill herdr` or `killall` takes them all down. `.oxlintrc.json` fails any `pkill` or `killall` in `e2e` code, except in the two tests that check Pi's refusal of them.
- A test that starts the fleet uses `Scratch` from `e2e/support/scratch.ts`: a copy of this repository with its own lane homes. Never point a test at the live main, its lanes, `~/.fleet`, or `~/.config/fleet`.

## Documents

- `docs/spec.md` is published from the maintainer's working copy. Do not edit it here. Describe a needed spec change in the pull request instead.
- Write documents in short, plain sentences. Do not use em dashes.
