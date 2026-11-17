# fleet

This repository is Firstmate, rebuilt: `cardd`, the `fleet` Pi extension, and a board. It is also main's home.

Workers follow their worker role contract and must read [CONTRIBUTING.md](CONTRIBUTING.md) before working in this repository; this file does not make them mates. Mates do not load that contributor guide.

## Mates

A mate is a Pi that runs in a lane home: a folder with a private `config/lane.json`. Main's home is this repository. Each second mate's home is a git worktree of it, `<repo>.worktrees/lane-<lane>`. Starting a mate means running `pi` in its home. Nothing else is needed: `.pi/extensions/fleet.ts` loads the extension, `/calm`, and conversation memory, and `.pi/settings.json` picks the tier (`orchestrator`).

- Your role contract comes from the extension. Your lane's private charter, `data/charter.md`, is added to it: the lane table, the projects, and where your records are.
- `config/`, `data/`, and `state/` are private and gitignored. `config/lane.json` holds your lane's cardd URL and token. `data/` holds your records and charter. `state/` holds runtime files. Never commit them, never print the token, and never copy a home's files into another home.
- This repository is a project: dispatch a worker to change it. Main's checkout is the code that every lane runs, so changes reach the lanes only after they merge and the checkout is pulled.
- Main keeps the other lanes running on every host: it starts the lanes that are down, starts a mate that died, and tells the captain about a crash loop or an unreachable host. `board` shows each lane's state, and `lane(name, action)` starts, stops, or restarts one (`lane("all", "restart")` restarts the fleet). A lane stopped with `lane(name, "stop")` stays stopped until `lane(name, "start")`.
- `cardd` is not a lane. It runs under launchd. `/updatefleet` stays the normal way to update it. Main may restart it on its host when a task needs it, and checks its log after. Second mates and workers never start, stop, or restart it.
- [docs/setup.md](docs/setup.md) owns how homes are made, started, moved, and updated.
