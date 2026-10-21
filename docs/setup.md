# Setup

This sets up the fleet on hosts that share a Tailscale network. One host runs `cardd`. Every host that runs mates or workers has a checkout of this repository.

The captain's routine is one step: open a terminal in the fleet repository and run `pi`. That Pi is main. Main brings up the rest of the fleet and keeps it running.

## How the pieces fit

- **Main's home is this repository.** `.pi/extensions/fleet.ts` loads the fleet extension, `/calm`, and conversation memory. `.pi/settings.json` starts Pi on the `orchestrator` tier. `AGENTS.md` holds the standing instructions. Main's private files are in `config/`, `data/`, and `state/`, which git ignores.
- **Each second mate's home is a git worktree of this repository**, at `<repo>.worktrees/lane-<lane>`, with its own private `config/`, `data/`, and `state/`. A mate is `pi` run in its home. On a host that does not have main, the checkout there plays the same part: it is the root of that host's lane homes.
- **A lane home is a folder with `config/lane.json`.** Pi started anywhere else loads none of this. A worker in a worktree of this repository gets only the extension that dispatch passes with `-e`, and needs no installed packages.
- **cardd is not part of main.** It runs under launchd on one host. Main never starts, stops, or restarts it.

## 1. A checkout on each host

```sh
git clone https://github.com/1yian/fleet ~/Projects/fleet     # on maverick, the captain's checkout
git clone https://github.com/1yian/fleet ~/.fleet/app         # on a host that only runs second mates
cd <checkout> && npm ci && npm run build
```

Keep the checkout on `main` and change the code only through worktrees, because every lane home on that host follows it. Each host needs Node 24 or later, Pi, herdr, git, `gh` (logged in), `zstd`, and `no-mistakes` for projects that use it.

To update later: `git -C <checkout> pull && (cd <checkout> && npm ci && npm run build)`. The lanes move to the new commit when their mates next start, so then run `lane_restart` with lane `all` from main (or `fleet restart` on that host). A lane home with uncommitted changes stays where it is.

## 2. cardd

`cardd` runs on one host and binds to that host's Tailscale address. It refuses every-interface addresses, because the board has no login.

```sh
CARDD="node $HOME/.fleet/app/packages/cardd/src/main.ts"
mkdir -p ~/.fleet
IP=$(tailscale ip -4)
NAME=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
$CARDD serve --db ~/.fleet/cards.db --listen "$IP:7420" --hostname "$NAME:7420" --board ~/.fleet/app/packages/board/dist
```

On macOS, run it under launchd with `KeepAlive` so it restarts after a crash or a reboot. The board is then at `http://<NAME>:7420/`. Update it by hand, apart from main: pull its checkout, build, and restart its launchd job.

## 3. Lanes and projects

Run these once on the `cardd` host. `lane add` prints the mate's token. A lane's `--home` is informational.

```sh
$CARDD lane add main --db ~/.fleet/cards.db --home ~/Projects/fleet
$CARDD lane add cleo --db ~/.fleet/cards.db --home /path/on/its/host --parent main
$CARDD project add web --db ~/.fleet/cards.db --delivery no-mistakes \
  --clone maverick=/path/to/web --clone p620=/path/on/p620/web
$CARDD grant add --db ~/.fleet/cards.db --lane main --project web --merge --words "<where the permission came from>"
```

- A project's clone is a normal clone of the repository on that host. Dispatch creates each worker's worktree next to it, in `<clone>.worktrees/`.
- Use the same host names in `--clone` that mates pass to `dispatch`.

## 4. Main

In the fleet repository, write main's settings and charter. Both are private.

```sh
cd ~/Projects/fleet
mkdir -p config data
cat > config/lane.json <<'JSON'
{
  "lane": "main",
  "url": "ws://<cardd Tailscale address>:7420/session",
  "token": "<the token from lane add main>",
  "hosts": { "p620": ["ssh", "p620"] },
  "roots": { "p620": "/home/me/.fleet/app" },
  "workerArgs": ["--model", "tier/quick"]
}
JSON
$EDITOR data/charter.md      # the lane table, main's own projects, and where its records are
pi
```

- `hosts` names the hosts that main reaches over SSH. A host that is not listed runs here. `roots` is each remote host's checkout, and defaults to `~/.fleet/app`.
- `workerArgs` are extra Pi arguments for main's workers. For main's own Pi, use Pi's settings: `.pi/settings.json` sets `tier/orchestrator`. `args` is only used when `fleet up` starts a second mate.
- `data/charter.md` is added to main's role contract at every start. Keep the lane table there: each lane's name, host, and scope. Keep the captain's preferences and records here too, under `data/`.
- `pi -c` continues the last conversation in this folder. Plain `pi` starts a new one, and conversation memory carries what matters.

### Conversation memory (optchat)

Every mate has conversation memory the way Firstmate's homes do. The loader is the user-level `~/.pi/agent/extensions/fm-optchat`, from the dotfiles. Firstmate sets `FM_HOME` for it with `optpi`. Here, `.pi/extensions/fleet.ts` loads it again with `FM_HOME` set to the home, when the home has `config/optchat.json`. Nothing else changes in `~/.pi`.

One command turns memory on in a home, for main and for each second mate alike:

```sh
<checkout>/bin/fleet home memory <lane> [--seed <profile folder>] [--compactor tier/compact] [--thinking low]
```

It does three things, all inside that lane's home, and skips each one that is done already:

- prepares the pinned pi-optchat package in `config/optchat/package` with the loader's own helper, `~/.pi/agent/optchat/package.mjs`. It fetches the version that the helper pins with `npm pack`. `--source <folder>` prepares it from a published copy that is already on disk instead.
- makes the lane's profile in `data/optchat/profiles/<lane>`. With `--seed`, it copies only `AGENTS.md` and `config.json` from that folder, such as the lane's old Firstmate profile. Without it, the profile is new. Either way the memory starts empty.
- writes `config/optchat.json`: the package, `data/optchat` as the memory home, and the lane as the profile. `--compactor` and `--thinking` pick the memory's compactor. Without `--compactor`, the memory uses the mate's own model.

Each lane has its own profile in its own home. Never copy one home's `config/`, `data/`, or `state/` into another. The profile's lock socket must fit a socket path (103 bytes on macOS), so the command refuses a home whose path is too long.

The mate gets memory at its next start. `/firstmate-memory` shows whether it is active, and `state/optchat-activation.json` in the home is the receipt. To turn it off, set `"enabled": false` in `config/optchat.json` and restart the mate.

The loader must treat a `[fleet]` message as a normal turn that enters memory. That needs the dotfiles at or after https://github.com/1yian/dotfiles/pull/34 on every host that runs a mate. `e2e/extension/memory.test.ts` checks it for main and for a second mate.

## 5. Second mates

On the host where a mate runs, from that host's checkout:

```sh
<checkout>/bin/fleet home add cleo --url ws://<cardd>:7420/session --token <the token from lane add cleo> \
  --args '["--model","tier/default"]' --worker-args '["--model","tier/quick"]'
<checkout>/bin/fleet home memory cleo --compactor tier/compact --thinking low
$EDITOR <checkout>.worktrees/lane-cleo/data/charter.md     # cleo's charter
```

This makes the home as a worktree of the checkout, with `config/lane.json`, and turns on its conversation memory (section 4). The mate's own settings:

- `args` are extra Pi arguments for the mate. `workerArgs` are for its workers.
- `hosts` and `roots` work as for main, when this mate dispatches to other hosts.
- `direnv` names a folder whose direnv environment the mate runs in, such as `"~/cnp"` (`--direnv` on `home add`). The mate starts as `direnv exec <folder> pi`, so it gets what that folder's `.envrc` exports, and its home stays where it is. Every start, restart, and restart of a dead mate does this. The folder's `.envrc` must be allowed (`direnv allow <folder>`). The setting does not reach the mate's workers: a worker gets that environment only from its own pane's shell, such as a shell with the direnv hook in a worktree under that folder.
- `data/charter.md` is the lane's charter, added to its role contract.

On a remote host, `fleet` must work over a non-interactive SSH session, so Node must be on that session's `PATH`. Check it from main's host: `ssh p620 '~/.fleet/app/bin/fleet status'`.

You do not start second mates by hand. Main starts them.

## 6. Day to day

```sh
cd ~/Projects/fleet && pi
```

Main starts, and within a minute it has brought up every lane on every host that is not running. After that:

- Main starts a mate that died, on whichever host it runs. It says so in its thread.
- A lane that starts three times in ten minutes is held, and main tells the captain once.
- A host that cannot be reached is reported once, and again when it answers.
- `lane_stop` stops a lane and holds it, so main leaves it alone. `lane_start` starts it. `lane_restart` restarts one lane, or every lane that is not held with lane `all`, on every host. Ask main in plain words: "restart the fleet".
- Each mate runs in its own herdr workspace, `fleet-<lane>`, in that host's `default` session, and continues its conversation when it starts again. To see another host's workspaces in the herdr you already use, add the host once as a machine: `herdr machine add p620 --remote-session default`.

The same commands are on each host as `fleet` (`<checkout>/bin/fleet`):

| Command                     | Does                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `fleet status [--json]`     | Shows each lane on this host: running, down, or stopped.                              |
| `fleet up [lane]`           | Starts each lane that does not run. A stopped lane stays stopped unless it is named.  |
| `fleet stop <lane>`         | Closes the lane's workspace and holds the lane.                                       |
| `fleet restart [lane]`      | Starts the mate again on its conversation. No lane means every lane that is not held. |
| `fleet home add <lane> ...` | Makes a lane's home.                                                                  |
| `fleet home memory <lane>`  | Turns on the lane's conversation memory (section 4).                                  |
| `fleet migrate [--undo]`    | Moves the earlier layout into homes (below).                                          |

When a lane starts, its home moves to the commit its checkout has, unless the home has uncommitted changes.

## Moving from the earlier layout

Before this layout, main's home was `~/fleet-homes/main`, each mate's settings were in `~/.config/fleet/<lane>.json`, mates ran from `~/.fleet/app`, and `fleet up` started them. Migration only copies. It changes nothing in cardd, so every card, entry, and live worker stays. It never deletes an old home, an old conversation, or a record.

1. Pull the new code in the captain's checkout and in each host's checkout, and run `npm ci && npm run build` in each.
2. Stop main's old Pi and every mate that `fleet up` started (close their `fleet-<lane>` workspaces). A mate that stays up keeps running on the old code until its pane is closed.
3. On each host, run `<checkout>/bin/fleet migrate`. It reads `~/.config/fleet/*.json` (or `--from <dir>`) and, for each file:
   - writes `config/lane.json` in the new home: the repository for `main`, and a new worktree `lane-<lane>` for any other lane;
   - copies the old home's `AGENTS.md` to `data/charter.md`, and its `config/` folder to `config/` (the `/calm` choice);
   - copies the old home's Pi conversations to the new home, so `pi -c` continues them;
   - renames the settings file to `<lane>.json.migrated`, so nothing starts the lane twice.

   A repeat finds nothing to migrate.

4. Records that lived outside the home, such as Firstmate's `data`, stay where they are. The charter names them by path.
5. Set up conversation memory (section 4) for each lane, then `cd ~/Projects/fleet && pi`.
6. Retire the old pieces when you are satisfied: `~/fleet-homes/main`, and `~/.fleet/app` on maverick if cardd does not run from it.

To go back, run `<checkout>/bin/fleet migrate --undo` on each host. It renames each `<lane>.json.migrated` to `<lane>.json` and sets aside each home's `config/lane.json` as `lane.json.undone`, so the new layout starts no lane. Then start the mates with the earlier code: check out the commit before this change in each checkout. The new homes stay on disk. Remove one with `git worktree remove <home>`.
