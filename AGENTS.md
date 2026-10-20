# fleet

This repository is Firstmate, rebuilt: `cardd`, the `fleet` Pi extension, and a board. It is also main's home. Read [docs/spec.md](docs/spec.md) for the design and [docs/build-plan.md](docs/build-plan.md) for the build order.

This file has two parts. "Mates" is for main and the second mates, which run in a home made from this repository. "Working in this repository" is for anyone who changes the code, including a worker that a mate dispatched into a worktree of this repository. A worker follows its worker role contract and the second part. Having this file in its folder does not make it a mate.

## Mates

A mate is a Pi that runs in a lane home: a folder with a private `config/lane.json`. Main's home is this repository. Each second mate's home is a git worktree of it, `<repo>.worktrees/lane-<lane>`. Starting a mate means running `pi` in its home. Nothing else is needed: `.pi/extensions/fleet.ts` loads the extension, `/calm`, and conversation memory, and `.pi/settings.json` picks the tier (`orchestrator`).

- Your role contract comes from the extension. Your lane's private charter, `data/charter.md`, is added to it: the lane table, the projects, and where your records are. Read it as part of this file.
- `config/`, `data/`, and `state/` are private and gitignored. `config/lane.json` holds your lane's cardd URL and token. `data/` holds your records and charter. `state/` holds runtime files. Never commit them, never print the token, and never copy a home's files into another home.
- This repository is a project like any other. Do not edit, commit, or run state-changing commands in it: dispatch a worker. Main's checkout is the code that every lane runs, so changes reach the lanes only after they merge and the checkout is pulled.
- Main keeps the other lanes running on every host: it starts the lanes that are down, starts a mate that died, and tells the captain about a crash loop or an unreachable host. Use `lane_status`, `lane_start`, `lane_stop`, and `lane_restart` (lane `all` restarts the fleet). A lane stopped with `lane_stop` stays stopped until `lane_start`.
- `cardd` is not a lane. It runs under launchd. Never start, stop, or restart it.
- [docs/setup.md](docs/setup.md) owns how homes are made, started, moved, and updated.

## Working in this repository

### Commands

- `npm run check` runs every static gate: format, lint, typecheck, knip, dependency-cruiser, and the migration check.
- `npm run test:e2e` builds the board, then runs every end-to-end test. Board tests drive Chromium through playwright, so run `npx playwright install chromium` once.

### Rules

- The gates in `eslint.config.js`, `tsconfig.json`, `knip.json`, and `.dependency-cruiser.cjs` are the rules. Inline disable comments do not work. Change a rule only in its config file, and say why in the pull request.
- Validate data that crosses a process boundary (websocket messages, database rows, environment variables, Pi events) with the schemas in `@fleet/protocol` or a narrowing helper. Trust typed data inside.
- `cardd`, the extension, and the board share only `@fleet/protocol`. End-to-end tests import only `@fleet/protocol`.
- Migrations in `packages/cardd/migrations` are append-only. Add a new numbered file, then run `npm run migrations:check -- --write` to update `schema.sql`.

### Tests

- Tests are end-to-end only. They start real processes (`cardd`, Pi with the scripted fake model in `e2e/support`, and Chromium for the board) and assert what a session or a user sees. Do not write unit tests.
- A behavior change needs an end-to-end test. A bug fix needs a test that fails before the fix.
- Do not wait with fixed sleeps. Wait for an event, an entry, or a state.
- Do not test by reading source files for strings.
- A test that starts the fleet uses `Scratch` from `e2e/support/scratch.ts`: a copy of this repository with its own lane homes. Never point a test at the live main, its lanes, `~/.fleet`, or `~/.config/fleet`.

### Documents

- `docs/spec.md` is published from the maintainer's working copy. Do not edit it here. Describe a needed spec change in the pull request instead.
- Write documents in short, plain sentences. Do not use em dashes.
