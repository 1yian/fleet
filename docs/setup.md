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

Keep the checkout on `main` and change the code only through worktrees, because every lane home on that host follows it. Each host needs Node 24 or later, Pi, herdr, git, `gh` (logged in), `zstd`, `lavish-axi` 0.1.80 or later, and `no-mistakes` for projects that use it.

`lavish-axi` is a prerequisite of the fleet. Workers show the captain HTML review pages with it, and the fleet waits on the captain's feedback with it. Install it on each host, so that it is on the `PATH` of the mates' and workers' shells and of a non-interactive SSH session:

```sh
npm install -g lavish-axi
lavish-axi --version     # 0.1.80 or later
```

`fleet up` and `fleet restart` refuse to start a mate on a host whose `lavish-axi` is missing or too old, and say how to install it. Main runs `fleet up` on every host when it starts and every minute after, so it tells the captain about such a host. A worker's `wait_review` refuses the same way. Each host runs its own Lavish server, so the captain's browser must reach that host, as it does over Tailscale.

To update later, type `/updatefleet` in main, or ask main to update the fleet. Section 7 says what it does.

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
$CARDD project yolo web on --db ~/.fleet/cards.db
```

- A project's clone is a normal clone of the repository on that host. Dispatch creates each worker's worktree next to it, in `<clone>.worktrees/`.
- Use the same host names in `--clone` that mates pass to `dispatch`.
- A project's yolo flag is the captain's standing merge authority: with it on, a mate tells the worker to merge a PR of that project with green checks, without asking the captain. Only the captain sets it, with `project add --yolo` or `project yolo <name> on|off`. No mate tool changes it.
- `cardd` finds a ship card's PR on GitHub by the card's branch, so it needs the project's GitHub repository. It reads it from the `origin` remote of a clone on the `cardd` host, when the project is added and each time `cardd serve` starts. A project with no clone on that host needs `--repo <owner>/<name>` on `project add`.
- The fleet keeps clones current with their `origin`, as Firstmate did. Dispatch fetches first and branches from `origin/<base>`, and refuses when the fetch fails. When main starts, and after `close` ends a ship card, each clone is fetched, branches whose remote branch is gone are pruned, and a clean base branch is fast-forwarded. A clone with uncommitted changes, another branch checked out, or a diverged base is left alone and reported as `STUCK`. A clone that is a fleet home, such as main's checkout, is only fetched: update it with `/updatefleet` (section 7).

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
- `workerArgs` are extra Pi arguments for main's workers. A `--model` in them picks the workers' model. Without one, workers start on Pi's global default model, `defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json` of the host where the mate runs. A worker never takes its model from its folder, so a worker in a worktree of this repository does not run on the mates' tier.
- For main's own Pi, use Pi's settings: `.pi/settings.json` sets `tier/orchestrator`. `args` is only used when `fleet up` starts a second mate.
- `data/charter.md` is added to main's role contract at every start. Keep the lane table there: each lane's name, host, and scope. Keep the captain's preferences and records here too, under `data/`.
- `pi -c` continues the last conversation in this folder. Plain `pi` starts a new one, and conversation memory carries what matters.

### Conversation memory (optchat)

Every mate has conversation memory the way Firstmate's homes do. The loader is the user-level `~/.pi/agent/extensions/fm-optchat`, from the dotfiles. Firstmate sets `FM_HOME` for it with `optpi`. Here, `.pi/extensions/fleet.ts` loads it again with `FM_HOME` set to the home, when the home has `config/optchat.json`. Nothing else changes in `~/.pi`.

One command turns memory on in a home, for main and for each second mate alike:

```sh
<checkout>/bin/fleet home memory <lane> [--seed <profile folder>] [--compactor tier/compact] [--thinking low]
```

It does three things, all inside that lane's home, and skips each one that is done already:

- prepares the pinned pi-optchat package in `config/optchat/package` with the loader's own helper, `~/.pi/agent/optchat/package.mjs`. It fetches the version that the helper pins with `npm pack`. `--source <folder>` prepares it from a published copy that is already on disk instead. If the loader refuses the package that is there, such as after a dotfiles update changed a patch, it moves that copy to `config/optchat/package.stale-<time>` and prepares the package again. Run the command again in each home after such an update, before the mates restart.
- makes the lane's profile in `data/optchat/profiles/<lane>`. With `--seed`, it copies only `AGENTS.md` and `config.json` from that folder, such as the lane's old Firstmate profile. Without it, the profile is new. Either way the memory starts empty.
- writes `config/optchat.json`: the package, `data/optchat` as the memory home, and the lane as the profile. `--compactor` and `--thinking` pick the memory's compactor. Without `--compactor`, the memory uses the mate's own model. If the file is there with `"enabled": false`, it sets `"enabled": true` and keeps the rest.

Each lane has its own profile in its own home. Never copy one home's `config/`, `data/`, or `state/` into another. The profile's lock socket must fit a socket path (103 bytes on macOS), so the command refuses a home whose path is too long.

The mate gets memory at its next start. `/firstmate-memory` shows whether it is active, and `state/optchat-activation.json` in the home is the receipt. To turn it off, set `"enabled": false` in `config/optchat.json` and restart the mate. To turn it on again, run `fleet home memory <lane>` and restart the mate.

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

- `args` are extra Pi arguments for the mate. `workerArgs` are for its workers, and pick their model as they do for main.
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
- `lane(name, "stop")` stops a lane and holds it, so main leaves it alone. `lane(name, "start")` starts it. `lane(name, "restart")` restarts one lane, and `lane("all", "restart")` every lane that is not held, on every host. Ask main in plain words: "restart the fleet".
- Each second mate runs in its own herdr workspace, `2ndmate-<lane>`, in that host's `default` session, and continues its conversation when it starts again. Each mate names itself when it starts: its Pi session and its herdr workspace read `1stmate` for main and `2ndmate-<lane>` for a second mate. A mate still in a workspace from before, `fleet-<lane>`, is found there until it restarts. To see another host's workspaces in the herdr you already use, add the host once as a machine: `herdr machine add p620 --remote-session default`.

The same commands are on each host as `fleet` (`<checkout>/bin/fleet`):

| Command                     | Does                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `fleet status [--json]`     | Shows each lane on this host: running, down, or stopped.                              |
| `fleet up [lane]`           | Starts each lane that does not run. A stopped lane stays stopped unless it is named.  |
| `fleet stop <lane>`         | Closes the lane's workspace and holds the lane.                                       |
| `fleet restart [lane]`      | Starts the mate again on its conversation. No lane means every lane that is not held. |
| `fleet update [--check]`    | Updates this host's checkout and lane homes for `/updatefleet` (section 7).           |
| `fleet home add <lane> ...` | Makes a lane's home.                                                                  |
| `fleet home memory <lane>`  | Turns on the lane's conversation memory (section 4).                                  |
| `fleet migrate [--undo]`    | Moves the earlier layout into homes (below).                                          |

When a lane starts, its home moves to the commit its checkout has, unless the home has uncommitted changes.

## 7. Updating the fleet

Type `/updatefleet` in main, or ask main in plain words to update the fleet (its `update_fleet` tool). It updates every host in main's `config/lane.json` to the latest `origin/main`, restarts every lane, and then restarts main. It is Firstmate's `/updatefirstmate` for the fleet.

1. **Check every host first.** On each host, `fleet update --check` fetches `origin` and looks at the checkout and every lane home on that host. Any of these stops the whole update before anything changes: a host that cannot be reached, a checkout that is not on `main`, uncommitted changes in a checkout or a lane home, or commits in either that are not on `origin/main`. Main reports each problem with its host and path. Nothing is pulled, and no mate restarts. Fix what it names, then run the update again.
2. **Update each host in turn.** `fleet update` checks again, fast-forwards the checkout to `origin/main`, runs `npm ci` when `package-lock.json` changed, builds the board, and moves every lane home on that host to the new commit. It never forces, merges, or stashes, and it never touches a home's `config/`, `data/`, or `state/`. A failed pull, install, or build stops the update there: no mate restarts, main keeps running, and the report says which hosts were already updated. Run the update again once the cause is fixed. A host that is already current is rebuilt, so a rerun converges.
3. **Restart every lane**, on every host, as `lane("all", "restart")` does. A held lane stays held. Each mate continues its conversation.
4. **Report and restart main.** The report names each host with its old and new commit, whether packages were installed, and the lane homes it moved, then each lane's restart. It also says whether the board or `cardd` changed. Main tells you the outcome, and when that turn ends it restarts on its own conversation, so the report stays in it.

Main restarts itself only when it runs in a herdr pane. Otherwise the report says so: restart it with `pi -c` in its home.

The update never touches `cardd`. `cardd` reads the board's files from disk at each request, so a new board needs no restart when `cardd` serves this checkout's build. When the update changes `packages/cardd` or `packages/protocol`, the report says that `cardd` still runs the old code. Update its checkout and restart its launchd job yourself (section 2).

A host updates with the code it already has. A host whose checkout predates `fleet update` cannot take part, so update it once by hand: `git -C <checkout> pull && (cd <checkout> && npm ci && npm run build)`, then `fleet restart` on that host.

## Moving from the earlier layout

Before this layout, main's home was `~/fleet-homes/main`, each mate's settings were in `~/.config/fleet/<lane>.json`, mates ran from `~/.fleet/app`, and `fleet up` started them. Migration only copies. It changes nothing in cardd, so every card, entry, and live worker stays. It never deletes an old home, an old conversation, or a record.

1. Pull the new code in the captain's checkout and in each host's checkout, and run `npm ci && npm run build` in each.
2. Stop main's old Pi and every mate that `fleet up` started (close their `2ndmate-<lane>` workspaces). A mate that stays up keeps running on the old code until its pane is closed.
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
