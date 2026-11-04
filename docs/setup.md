# Setup

This sets up the fleet on hosts that share a Tailscale network. One host runs `cardd`. Every host that runs mates or workers has a checkout of this repository.

The captain's routine is one step: open a terminal in the fleet repository and run `pi`. That Pi is main. Main brings up the rest of the fleet and keeps it running.

## How the pieces fit

- **Main's home is this repository.** `.pi/extensions/fleet.ts` loads the fleet extension, `/calm`, and conversation memory. `.pi/settings.json` starts Pi on the `orchestrator` tier. `AGENTS.md` holds the standing instructions. Main's private files are in `config/`, `data/`, and `state/`, which git ignores.
- **Each second mate's home is a git worktree of this repository**, at `<repo>.worktrees/lane-<lane>`, with its own private `config/`, `data/`, and `state/`. A mate is `pi` run in its home. On a host that does not have main, the checkout there plays the same part: it is the root of that host's lane homes.
- **A lane home is a folder with `config/lane.json`.** Pi started anywhere else loads none of this. A worker in a worktree of this repository gets only the extension that dispatch passes with `-e`, and needs no installed packages.
- **cardd is not part of main.** It runs under launchd on one host, from its own checkout. Only `/updatefleet` restarts it (section 7). Never start, stop, or restart it by hand.

## Prerequisites

Every host that runs a mate or a worker needs these tools on the `PATH` of the mates' and workers' shells and of a non-interactive SSH session. One check owns the list: `packages/extension/src/prerequisites.ts`.

| Tool                | Minimum                  | Why                                                  | Install or fix                                                                                    |
| ------------------- | ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `node`              | 24                       | Runs the extension, `fleet`, and `cardd`.            | `brew install node@24` (macOS) or see https://nodejs.org                                          |
| `git`               | 2.31                     | Lane homes, worktrees, and dispatch.                 | `brew install git` (macOS) or `apt install git` (Debian)                                          |
| `gh`                | any, and logged in       | Finds and merges pull requests.                      | `brew install gh` or `apt install gh`, then `gh auth login`. The check runs `gh auth status`.     |
| `herdr`             | 0.9.5                    | Every mate, worker, and job runs in a herdr pane.    | https://github.com/herdrdev/herdr/releases                                                        |
| `zstd`              | any                      | Archives a closed card's worktree.                   | `brew install zstd` or `apt install zstd`                                                         |
| `no-mistakes`       | any                      | Validates the changes of projects that use it.       | `curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh \| sh` |
| `direnv`            | any                      | Mates and clone commands run under `direnv exec`.    | `brew install direnv` or `apt install direnv`                                                     |
| conversation memory | the lane has its profile | A mate with `config/optchat.json` loads it at start. | `<checkout>/bin/fleet home memory <lane>` (section 4)                                             |

The `gh` login check runs only when `fleet up` or `fleet restart` is run by hand and in `update_fleet`. Main's once-a-minute lane pass runs `fleet up --maintenance`, which skips it, so a slow GitHub cannot mark a host failed. Only a definite logged-out verdict refuses. A timeout or any other unknown verdict prints a warning on stderr and does not refuse.

Conversation memory is checked for every home on the host whose `config/optchat.json` does not say `"enabled": false`. The profile that the file names must have its `AGENTS.md` and `config.json`. Without them the memory cannot start, and the mate would crash-loop. OptChat itself ships in this repository, so there is nothing to install for it.

The fleet checks all of this on each host before it starts a mate, and before `/updatefleet` changes anything:

- `fleet up` and `fleet restart` print every problem of the host, one on each line, then exit without starting a mate. Each line names the tool, the host, and the fix. Main runs `fleet up` on every host when it starts and every minute after, so it tells the captain about such a host.
- `fleet update --check` and `fleet update` report the same problems as a refusal. `update_fleet` and `/updatefleet` check every host in `config/lane.json` first, over its transport, and stop before they pull, build, or restart anything. The refusal lists the problems of every host at once.

The check does not test that the cardd host is reachable over Tailscale. Mates reconnect to `cardd` by themselves while it restarts, so a mate must start when `cardd` is down, and a reachability test would be slow and flaky.

`lavish-axi` is optional. A host without it starts its mates and runs its workers with no problem reported. Install it (`npm install -g lavish-axi`, 0.1.80 or later) to let workers show review pages, so the fleet waits on the captain's feedback there. 0.1.80 is the first release whose `reply` confirms that the page took the answer. On a host where it is missing or older, a worker's `lavish-axi` command is not found, so the worker writes a plain Markdown report and reports `needs-decision` or `done` with its path.

`bws` is optional too. A host without it, or a lane without a `bws` block in `config/lane.json`, reads every secret from the files and environment it always did. Install it (`bws` 2 or later, the Bitwarden Secrets Manager CLI, https://bitwarden.com/help/secrets-manager-cli/) on each host whose lanes should read from Bitwarden. See [Secrets from Bitwarden](#secrets-from-bitwarden-bws).

Each host that has Lavish runs its own Lavish server, so the captain's browser must reach that host, as it does over Tailscale.

## 1. A checkout on each host

```sh
git clone https://github.com/1yian/fleet ~/Projects/fleet     # on maverick, the captain's checkout
git clone https://github.com/1yian/fleet ~/.fleet/app         # on a host that only runs second mates
cd <checkout> && npm ci && npm run build
```

Keep the checkout on `main` and change the code only through worktrees, because every lane home on that host follows it. Every host needs the tools in [Prerequisites](#prerequisites).

To update later, type `/updatefleet` in main, or ask main to update the fleet. Section 7 says what it does.

## 2. cardd

`cardd` runs on one host and binds to that host's Tailscale address. It refuses every-interface addresses, because the board has no login.

```sh
CARDD="node $HOME/.fleet/app/packages/cardd/src/main.ts"
mkdir -p ~/.fleet
IP=$(tailscale ip -4)
NAME=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
$CARDD serve --db ~/.fleet/cards.db --listen "$IP:7420" --hostname "$NAME:7420" --board ~/.fleet/app/packages/board/dist \
  --hosts '{"p620":["ssh","p620"]}'
```

`--hosts` names the hosts that `cardd` reaches over SSH, in the same form as `hosts` in main's `config/lane.json` (section 4). A host that is not listed runs here. `cardd` uses them only to read each project's GitHub repository from a clone (section 3). The SSH session must run without a prompt, so use a key that `cardd`'s launchd job can use.

On macOS, run it under launchd with `KeepAlive` so it restarts after a crash or a reboot, as the job `dev.fleet.cardd` in `~/Library/LaunchAgents/dev.fleet.cardd.plist`. The board is then at `http://<NAME>:7420/`.

Set `ProcessType` to `Interactive` in the plist, next to `KeepAlive`:

```xml
<key>KeepAlive</key>
<true/>
<key>ProcessType</key>
<string>Interactive</string>
```

Without it, launchd applies light resource limits (`launchd.plist(5)`): it throttles CPU and I/O, and `cardd` ran below the Docker VM and the agents it serves. `Interactive` gives it normal priority. The plist is written by hand, so nothing in this repository rewrites it. `/updatefleet` pulls code and runs `cardd.restart` (`launchctl kickstart -k`), which restarts the job without re-reading the plist. To apply a plist change, the captain edits the file, then runs `launchctl bootout gui/<uid>/dev.fleet.cardd` and `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/dev.fleet.cardd.plist`. Check it with `launchctl print gui/<uid>/dev.fleet.cardd | grep -i processtype`.

### Running cardd without launchd

launchd is only one way to keep `cardd` running. Any supervisor works if it restarts `cardd` after a crash and gives `lane.json` a command that restarts it.

For a single machine, such as a laptop, listen on loopback. The lanes, the mates, and the board are all on this machine, so nothing needs Tailscale:

```sh
node $HOME/.fleet/app/packages/cardd/src/main.ts serve --db ~/.fleet/cards.db \
  --listen 127.0.0.1:7420 --hostname 127.0.0.1:7420 --board ~/.fleet/app/packages/board/dist
```

On loopback, `cardd` accepts the Host headers `127.0.0.1`, `localhost`, and `[::1]` with its port, plus each `--hostname`. It answers any other Host with a 403 that lists the hosts it accepts. This keeps the protection against DNS rebinding. Lane URLs are then `ws://127.0.0.1:7420/session`.

**A user-space supervisor.** On a host without systemd, such as WSL2, write a small script, `fleet-cardd`, that takes `start`, `stop`, `restart`, and `status`:

- `start` runs the command above in a loop, so it starts again after a crash. It appends to `~/.fleet/cardd.log` and writes the supervisor's pid to `~/.fleet/cardd.pid`. It does nothing when that pid is alive.
- `stop` signals the pid in `~/.fleet/cardd.pid`, which ends the loop and `cardd`.
- `restart` is `stop`, then `start`.
- `status` prints whether the pid is alive and exits non-zero when it is not.

**A systemd user unit.** On a host with systemd, use `~/.config/systemd/user/cardd.service` with `Restart=always` and an `ExecStart` that uses `%h` for the home directory, because systemd expands neither `~` nor `$HOME`:

```ini
ExecStart=/usr/bin/node %h/.fleet/app/packages/cardd/src/main.ts serve --db %h/.fleet/cards.db --listen 127.0.0.1:7420 --hostname 127.0.0.1:7420 --board %h/.fleet/app/packages/board/dist
```

Use the absolute path of your `node`. Enable it with `systemctl --user enable --now cardd`. Run `loginctl enable-linger $USER` so it keeps running after logout.

**Tie it to the update.** `/updatefleet` restarts `cardd` with the `restart` command of the `cardd` entry in main's `config/lane.json` (section 4). Point it at your supervisor:

```json
"cardd": {
  "root": "~/.fleet/app",
  "db": "~/.fleet/cards.db",
  "restart": ["fleet-cardd", "restart"]
}
```

For systemd, use `["systemctl", "--user", "restart", "cardd"]`. The command must return once `cardd` has been told to restart. The update then waits up to a minute for `cardd` to answer on the new commit.

`/updatefleet` updates and restarts it (section 7), once main's `config/lane.json` names it (section 4). Do not update or restart it by hand. `cardd` answers `GET /api/version` with the commit its code runs and its database's schema version, so the update knows whether it runs old code.

## Process containment

Fleet tracks every process a worker starts, so that `close`, a worker restart (`restart_card` replace) kill the whole tree, even processes that detach, double-fork, `setsid`, run from `/tmp`, or clear their environment. It picks a backend on each host from what the host can do, never from its name:

- `systemd`: Linux with a systemd user session (`systemctl --user` works and `busctl` exists). Each worker's Pi and its children are moved into a transient scope named `fleet-worker-<session>-<hash of the worktree path>.scope`. Close and replace stop the scope's whole cgroup (TERM, then KILL after 5 seconds). Over ssh with no login session, enable lingering once: `loginctl enable-linger <user>`.
- `cgroup`: Linux without a systemd user session, but with a writable cgroup v2 subtree for the user. Same behavior through a child cgroup and `cgroup.kill`.
- `sweep`: everything else, including macOS today. Close stops the worker's process group and sweeps processes whose cwd or command line is inside the worktree. Processes that left both are not found. A launchd coalition backend needs herdr to start the pane inside a per-card launchd job, and herdr does not offer that yet.

A failure to attach containment fails the dispatch or restart, and a failure to confirm cleanup fails the close or restart, so nothing starts or finishes with processes left uncontained. Retry the operation once the host is reachable.

## 3. Lanes and projects

Run these once on the `cardd` host. `lane add` prints the mate's token. A lane's `--home` is informational.

```sh
$CARDD lane add main --db ~/.fleet/cards.db --home ~/Projects/fleet
$CARDD lane add cleo --db ~/.fleet/cards.db --home /path/on/its/host --parent main
$CARDD project add web --db ~/.fleet/cards.db --delivery no-mistakes \
  --clone maverick=/path/to/web --clone p620=/path/on/p620/web
$CARDD project clone web p620=/new/path/on/p620/web --db ~/.fleet/cards.db
$CARDD project yolo web on --db ~/.fleet/cards.db
$CARDD project repo web acme/web --db ~/.fleet/cards.db
$CARDD project delivery web direct-PR --db ~/.fleet/cards.db
$CARDD card delivery 125 direct-PR --db ~/.fleet/cards.db
```

- A project's clone is a normal clone of the repository on that host. Dispatch creates each worker's worktree next to it, in `<clone>.worktrees/`.
- To move a clone, move it, run `git worktree repair` with the paths of its worktrees, then run `project clone` with its new path. Workers that already run keep their worktrees, and close still finds them.
- Use the same host names in `--clone` that mates pass to `dispatch`.
- A project's yolo flag is the captain's standing merge authority: with it on, a mate tells the worker to merge a PR of that project with green checks, without asking the captain. The captain can set it with `project add --yolo` or `project yolo <name> on|off`, or tell main to set or clear it with `project_yolo(project, on)`. Main never changes it on its own initiative or on a second mate's request. Second mates and workers cannot change it. Destructive, irreversible, or security-sensitive merges still need the captain's words with yolo on.
- `project delivery <name> <mode>` sets the delivery mode (`no-mistakes`, `direct-PR`, or `local-only`) that ship cards created from then on take. Cards that already exist keep the mode they recorded. `card delivery <number> <mode>` changes the recorded mode of one open ship card. It refuses a closed card, a card that is not a ship card, and a card with a live worker, whose task already named its mode. For such a card, a mate dispatches with `delivery=<mode>` and `replace=true`, which starts its worker over with the new mode. No mate tool changes a project's default.
- Workers report their PR URL with `report(pr=<full https URL>)`, and their merge with `merged=true`. `cardd` never queries GitHub to discover a PR or confirm a merge. Close trusts the worker's report. Workers still check required CI before merging under the captain's authority or yolo.
- `project repo <name> <owner>/<name>` sets the project's repository metadata, also accepted as `--repo` on `project add`. Missing metadata can be read from a clone's `origin`; it is not needed to discover or confirm a PR.
- The fleet keeps clones current with their `origin`, as Firstmate did. Dispatch fetches first and branches from `origin/<base>`, and refuses when the fetch fails. When main starts, and after `close` ends a ship card, each clone is fetched, branches whose remote branch is gone are pruned, and a clean base branch is fast-forwarded. A clone with uncommitted changes, another branch checked out, or a diverged base is left alone and reported as `STUCK`. A clone that is a fleet home, such as main's checkout, is only fetched: update it with `/updatefleet` (section 7).
- Every fetch the fleet runs in a clone, by dispatch or by the refresh, runs as `direnv exec <clone> git ...` on the clone's own host. A clone under a folder whose `.envrc` exports a work login, such as `~/cnp`, then reaches its private remote. A clone with no `.envrc` fetches as before. The `.envrc` must be allowed (`direnv allow <folder>`) on that host. When it is not, the fleet fetches without it, and if that fails too, the refresh line and the dispatch error say `direnv blocks the .envrc that applies to <clone>, run: direnv allow <clone>`. `direnv` must be on the `PATH` of a non-interactive SSH session on a remote host. A worker gets the same environment only from its own pane's shell (section 5), which is the worktree next to the clone, under the same folder.

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
  "workerArgs": ["--model", "tier/quick"],
  "cardd": {
    "host": "local",
    "root": "~/.fleet/app",
    "db": "~/.fleet/cards.db",
    "restart": ["launchctl", "kickstart", "-k", "gui/<your uid>/dev.fleet.cardd"]
  }
}
JSON
$EDITOR data/charter.md      # the lane table, main's own projects, and where its records are
pi
```

- `host` is the name of the host this lane runs on, the same name that `--clone` and `dispatch` use for it. It defaults to this machine's hostname, first label, lower case. Set it when the hostname differs from the fleet's name for the host, such as `"host": "maverick"`.
- `hosts` names the hosts that main reaches over SSH. A host that is neither listed nor this lane's own host has no transport: the fleet never runs its commands here, and says `no transport for <host>`. `roots` is each remote host's checkout, and defaults to `~/.fleet/app`.
- `cardd` tells `/updatefleet` how to update `cardd` (section 7). `host` is the host that runs it, `local` by default or a name from `hosts`. `root` is the checkout it runs from, and `db` its database, both on that host, where `~` is that host's home. `restart` is the command that restarts its service on that host: for launchd, `launchctl kickstart -k gui/<uid>/<label>`, with the uid from `id -u`. Without `cardd`, the update leaves `cardd` alone and says when its code changed.
- `workerArgs` are extra Pi arguments for main's workers. A `--model` in them picks the workers' model. Without one, workers start on Pi's global default model, `defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json` of the host where the mate runs. A worker never takes its model from its folder, so a worker in a worktree of this repository does not run on the mates' tier.
- For main's own Pi, use Pi's settings: `.pi/settings.json` sets `tier/orchestrator`. `args` is only used when `fleet up` starts a second mate.
- Codemode is on in every fleet Pi: main, each second mate, and each worker, on every host. The fleet extension adds the `codemode` tool to the active tools when the session starts, and keeps the others. It also sets `PI_CODEMODE_MAX_WORKERS` to 4 unless the environment already sets it. Pi applies that limit to each Pi process, not to the whole host, and its default is 2. Each Pi process runs one session, so 4 lets one worker run several codemode scripts in parallel. Every host must run Pi 1.4.0 or newer on PATH for this limit to apply.
- `data/charter.md` is added to main's role contract at every start. Keep the lane table there: each lane's name, host, and scope. The captain's preferences are not charter text: they are standing rules (below).
- The fleet sets Pi's prompt cache retention by role: every mate (main and second mates) gets the one-hour tier, `long`, and every worker keeps the five-minute default, `short`. It overrides an inherited `PI_CACHE_RETENTION` and changes no settings file. Cache warming is not set per role: it follows Pi's global `cacheWarming` setting until Pi can set it per process. The reasons and the limits are in [code.md](code.md#prompt-cache-policy).
- The fleet also limits a worker's context by role: an effective limit of the model's own window capped at 500K, compacting at 80% of it: 400K on a 1M model, 160K on a 200K model. A mate keeps Pi's own limits. It changes no settings file. The reasons and the limits are in [code.md](code.md#worker-context-policy).
- `pi -c` continues the last conversation in this folder. Plain `pi` starts a new one, and conversation memory carries what matters.

### Standing rules and `/stow`

Every mate loads three files from its home's `data/` into its role contract on every turn, after its charter. A file that is missing or empty adds nothing. All three are private, like the rest of `data/`.

- `data/captain.md` holds the captain's preferences for this lane's domain and his working style.
- `data/captain-shared.md` holds preferences that hold across every lane. Main writes it. Main copies it, read-only, into `data/` of every second mate's home on every host: each minute when it checks the lanes (before it starts any), and at the end of `/stow`. A copy that differs from main's file is replaced, and the copy of a file that main no longer has is removed. Each home records the bytes main last put there (`state/captain-shared.published`). When a copy matches neither main's file nor that record, someone edited it: it is first saved as `data/captain-shared.edited-<time>.md`, which nothing loads, and main says so in its thread. The shared file wins either way, and an untouched copy is replaced without a trace. A second mate never writes it, and nothing copies it back. Where it conflicts with a lane's own preferences, it wins.
- `data/learnings.md` holds the operating facts of one home. It is never shared.

The mate edits these files itself: it reads a file in full, then writes a considered replacement. Edits take effect on the mate's next turn. Nothing here is stored in cardd or in the conversation memory.

`/stow` is a command of every mate, main and second mates alike. The captain types it in the mate's pane:

1. The mate gets the stow instructions and a report of its memory files: each entry with its tier and age, and the stale ones flagged. An aging entry is stale after 30 days, and a perishable one after 7. Entries in `captain.md` and `captain-shared.md` do not age unless they carry a marker.
2. The mate curates the files, routes what only this conversation knows to its owner, and files the open work it holds as cards on the board (`card_new`, `comment`, `hold`). It never writes open work into a memory file. A stale entry moves to `data/memory-archive.md`, which nothing loads. A second mate sends a shared preference to main with `comment`, and main files it.
3. When that turn ends, main copies `data/captain-shared.md` to every host. Then the mate reloads in the same conversation: Pi reads `AGENTS.md` and the other context files again and rebuilds the role contract, so a pulled change to `AGENTS.md` takes effect without a restart. The conversation continues, and the mate reconnects to cardd.

A stow in main does not stow the second mates: each one runs its own `/stow`.

### Conversation memory (optchat)

Every mate has conversation memory: OptChat, which ships in this repository at `packages/extension/vendor/optchat` (see its `README.md` for the version and changes). `.pi/extensions/fleet.ts` loads it when the home has `config/optchat.json`. Nothing is installed in `~/.pi`, and a dotfiles update cannot change it.

One command turns memory on in a home, for main and for each second mate alike:

```sh
<checkout>/bin/fleet home memory <lane> [--seed <profile folder>] [--thinking low]
```

It does two things, all inside that lane's home, and skips each one that is done already:

- makes the lane's profile in `data/optchat/profiles/<lane>`. With `--seed`, it copies only `AGENTS.md` and `config.json` from that folder, such as the lane's old Firstmate profile. Without it, the profile is new. Either way the memory starts empty. A profile that has only one of the two files gets the missing one, and the file that is there is kept.
- writes `config/optchat.json`: `data/optchat` as the memory home, and the lane as the profile. `--thinking` picks the thinking level of the memory's summaries. The fleet fixes the summary model: `tier/compact`, or for a CNP mate `vertex-claude/claude-haiku-5-5` and then `google-vertex/gemini-3.8-flash` (the Pi of a CNP home must register `vertex-claude`). A `compactorModel` or `compactorProvider` in the file is ignored. Summaries are thousands of small calls a day, so they never use the mate's expensive model. If the file is there with `"enabled": false`, it sets `"enabled": true` and keeps the rest.

Each lane has its own profile in its own home. Never copy one home's `config/`, `data/`, or `state/` into another. The profile's lock socket must fit a socket path (103 bytes on macOS), so the command refuses a home whose path is too long.

`config/optchat.json` also takes `"viewBudget"`, the size of the memory view in bytes, from 16000 to 128000 (default 128000). A smaller view costs fewer input tokens on every request, and summaries get coarser. It is set by hand in the lane's own home, then the mate restarts. `fleet home memory` keeps it.

`config/optchat.json` also takes `"mode": "fold"` (default: absent, the view is rebuilt every turn) and `"foldTokens"` (whole tokens, 1000 or more, default 150000). In fold mode the chat grows as a plain transcript with a stable prompt prefix, which raises the cache hit rate. Once the context passes `foldTokens`, the transcript folds into the memory view once and then grows plainly again. Older history stays reachable through zoom. A long single turn is not folded until it ends. It is set by hand, then the mate restarts.

`config/optchat.json` also takes `"foldOnCacheExpiry"` (boolean, default `true` in fold mode). When a run starts after the session has idled longer than its prompt cache lifetime, the transcript folds even below `foldTokens`, because the cached prefix is cold anyway and the fold costs no cache. The lifetime is the model's `promptCache` lifetime for the session's retention (one hour for a mate, five minutes for a worker), never a fixed number. A model with no known lifetime never folds this way. Set `false` to fold only at `foldTokens`.

The mate gets memory at its next start. `/firstmate-memory` shows whether it is active, and `state/optchat-activation.json` in the home is the receipt. To turn it off, set `"enabled": false` in `config/optchat.json` and restart the mate. To turn it on again, run `fleet home memory <lane>` and restart the mate.

A `[fleet]` message is a normal turn that enters memory. `e2e/extension/memory.test.ts` checks it for main and for a second mate. An older home's `config/optchat.json` may still name a `package`: it is ignored, and the `config/optchat/package` folder can be deleted.

## 5. Second mates

On the host where a mate runs, from that host's checkout:

```sh
<checkout>/bin/fleet home add cleo --url ws://<cardd>:7420/session --token <the token from lane add cleo> \
  --worker-args '["--model","tier/quick"]' \
  --host p620 --hosts '{"maverick":["ssh","maverick"]}'
<checkout>/bin/fleet home memory cleo --thinking low
$EDITOR <checkout>.worktrees/lane-cleo/data/charter.md     # cleo's charter
```

This makes the home as a worktree of the checkout, with `config/lane.json`, and turns on its conversation memory (section 4). The mate's own settings:

- `tier` is the optional model the mate starts on, such as `"tier/weaker-orchestrator"` (`--tier` on `home add`). Without it, the mate starts on `tier/orchestrator`. Every start and restart path uses it: `fleet up`, `fleet restart`, main's automatic lane starts, and `lane(name, start|restart)`. It must be a non-empty string.
- `args` are extra Pi arguments for the mate. A `--model` or `--provider` in `args` takes precedence over `tier`. `workerArgs` are for its workers, and pick their model as they do for main.
- `host`, `hosts`, and `roots` work as for main. Give a mate the transport of every other host that has a clone of a project it works on: when it closes a ship card, it refreshes the project's clone on each host, and a host with no transport is skipped with `no transport for <host>`. Main refreshes it when it next starts, and `/updatefleet` still moves a fleet home.
- `direnv` names a folder whose direnv environment the mate runs in, such as `"~/cnp"` (`--direnv` on `home add`). The mate starts as `direnv exec <folder> pi`, so it gets what that folder's `.envrc` exports, and its home stays where it is. Every start, restart, and restart of a dead mate does this. The folder's `.envrc` must be allowed (`direnv allow <folder>`). The setting does not reach the mate's workers: a worker gets that environment only from its own pane's shell, such as a shell with the direnv hook in a worktree under that folder.
- `data/charter.md` is the lane's charter, added to its role contract.

On a remote host, `fleet` must work over a non-interactive SSH session, so Node must be on that session's `PATH`. Check it from main's host: `ssh p620 '~/.fleet/app/bin/fleet status'`.

You do not start second mates by hand. Main starts them.

### Goal and scheduled wakes

A second mate can have a plan: a goal, and a schedule of wakes. The plan is on the lane card in `cardd`, and only the captain sets it, with the `cardd` command on its host (`$CARDD` as in section 2):

```sh
$CARDD lane plan cleo --db ~/.fleet/cards.db --plan '{
  "goal": "Book demos at the lowest cost. Allowance: spend at most $50 a day, and never change a campaign.",
  "timezone": "America/Chicago",
  "wakes": [
    { "at": "09:00", "purpose": "Review yesterday'"'"'s ad spend and clicks" },
    { "at": "09:00", "days": ["mon"], "purpose": "Write the weekly summary" }
  ]
}'
```

Without `--plan`, the command prints the active plan and the plan waiting to start, as JSON. Setting a plan again replaces the one waiting.

- `goal` is the lane's goal and standing instructions, as text. A limit, such as an allowance or a budget, is written in it. There is no field for a limit.
- `timezone` is an IANA name, such as `America/Chicago`. It is required, and it never defaults. Every `at` is the wall-clock time in that zone, on a 24-hour clock.
- A wake has an `at`, an optional `days` list (`mon` to `sun`, every day when left out), and a `purpose`: what the wake is for, in one line of at most 120 characters. A plan has at most 24 wakes. `cardd` refuses any other field, a bad time, a bad zone, and a purpose that is empty, has a line break, or is too long.
- The goal and the schedule enter the mate's role contract at its start. A changed plan applies after the mate restarts: `lane(<lane>, "restart")` in main, or `fleet restart <lane>` on its host. Until then the mate keeps the plan it loaded, and `cardd` fires only that one. The plan counts from the minute the mate loaded it: a wake time before that minute does not fire.
- `cardd` checks every 15 seconds. At a wake time it comments on the lane card for the mate: `[fleet] scheduled wake 2026-05-04T09:00 America/Chicago: Review yesterday's ad spend and clicks`. The mate answers with `comment(card, text, replyTo)`. An owed reply is resent after two minutes, then every five minutes until answered or withdrawn. Wakes due in the same minute join their purposes with `; `.
- An unanswered wake never skips the next scheduled wake. Main can withdraw an obsolete reply with `comment(lane, text, withdraws="r-N")`. See [Persistent wakes](wake-plan.md) for all reminders.
- A wake dispatches no worker and makes no card. The mate decides what to do, inside the goal.
- DST: a time that does not exist on a spring day fires when the clock first shows it or a later time. A time that happens twice on an autumn day fires once. A day is the calendar day in the plan's zone.
- A wake whose time passed while `cardd` was down fires at the next check, once for each wake, with the other wakes due then. Only its latest slot is made up, never the earlier ones. When it is older than the newest time in the message, its purpose carries `[due <time>]`.
- Restarts are safe. Each wake records the slots it covers on its own entry, so a restart of `cardd` or of the mate repeats none of them. A wake the mate had not taken in is delivered again at its next connect, as any message is.

A script, such as a guard that runs from cron, wakes the mate with a note:

```sh
<checkout>/bin/fleet wake cleo "Spend is 40% over the cap" --script guard
```

It runs on the host of the mate's home, and uses that home's `config/lane.json` for the address and token. When the lane has a `bws` block, the token comes from Bitwarden first, and the command prints its source on stderr ([Secrets from Bitwarden](#secrets-from-bitwarden-bws)). From another host, or without the command, `POST /call` with the lane's token does the same: `{"op": "wake", "args": {"note": "...", "script": "guard"}}`. The mate hears `[fleet] script wake guard: Spend is 40% over the cap`. A script wake owes no reply, and `cardd` does not limit it, so a script should wake the mate on a change, not on every run. The token is the lane's token: keep the script's file private.

Main has no lane card, so it has no plan and no wakes.

### Scheduled messages

Any mate, main included, can have `cardd` deliver a fixed message to main or to a second mate at a time. A schedule is only a time, a recipient, and the text. It holds no condition and does no work: the recipient decides what to do.

- `schedule_set(to, at, timezone, text, on?, id?)` makes a schedule, or changes the one named by `id`. `at` is `HH:MM` on a 24-hour clock in the IANA `timezone`. Without `on` it repeats every day. `on` is a local date, `YYYY-MM-DD`, for a message that is delivered once and then removed. A past `on` time, or a date that does not exist such as 2027-02-30, is refused. A lane has at most 24 schedules.
- `schedule_list()` shows a mate its own schedules, and main every lane's. `schedule_remove(id)` removes one, and it stops at once. A mate changes or removes only its own schedules.
- `cardd` checks every 15 seconds. At the time it delivers `[fleet] scheduled message from <owner>: <text>`, with the text word for word, to the recipient. It is an ordinary message: the same resend-until-read delivery applies ([Persistent wakes](wake-plan.md)), and no reply is owed. For a second mate it lands on its lane card. For main it lands on a standing card named `scheduled-messages`, which `cardd` makes the first time.
- A time that passed while `cardd` was down is delivered at the next check, once, as with wakes. A restart repeats nothing.
- The board lists every schedule in its rail, under Schedules, with its time, owner, recipient, and text.
- An unknown recipient, a bad time zone, or a text that is empty or longer than 500 characters is refused with an error.

To replace a launchd job that messages main at 05:00, main calls:

```
schedule_set(to="main", at="05:00", timezone="America/Chicago", text="<the daily-update message>")
```

## Secrets from Bitwarden (bws)

The fleet can read its machine secrets from Bitwarden Secrets Manager, so a secret is made once in Bitwarden and each host needs only its own machine-account token. Nothing changes for a lane until its `config/lane.json` has a `bws` block. Until then every secret comes from the file or the environment it came from before.

### What it reads, and what it does not

- **The lane token.** The token a mate (main or a second mate) uses to join `cardd`, and that `fleet wake` sends. Today it is `token` in `config/lane.json`.
- **Environment secrets.** `bws.env` maps an environment variable name to a secret, such as `GH_TOKEN` or a provider key. When a mate's Pi starts, the fleet reads each one and sets it in that Pi process, so the mate and every command it runs get it. The mate also hands the same map to each worker it dispatches, as a flag that holds only names, never a value. The worker's Pi reads them in its own process on its own host.
- **Not moved:** a worker's session token, which `cardd` makes for each attempt and the fleet passes to Pi with `--fleet-token`. It is not stored anywhere, so Bitwarden cannot hold it. Also not moved: `cardd`'s own signing key, which `cardd` makes and keeps in its database, and the `gh` login and Pi's own login files, which the fleet never reads.
- **A limit.** A secret set this way reaches Pi and the commands Pi runs. It does not reach a `run_long` job: its tab is a new shell from the pane, not a child of Pi, and the fleet writes no secret into the job's file.

### What to create in Bitwarden

The dotfiles' `bws-env` already expects the same projects and machine accounts. If they exist, reuse them and only add the secrets in step 4.

1. **Secrets Manager** is on for the organization.
2. **Projects.** One project named `Common`, for secrets that every lane may read. One project for each lane, named exactly like the lane: `main`, `cleo`. The lane's project wins over `Common` when both hold the same name. The fleet names a project by its id, never by its name. A project's id is a UUID. Find it in the URL of the project's page in the Bitwarden web vault, or run `bws project list` once by hand. Write down the id of the lane's project and of `Common`.
3. **Machine accounts.** One for each lane, named `fleet-<lane>`, with **read-only** access to the lane's project and to `Common`, and to nothing else. Make one access token for it. The fleet only reads, so a lane's token can never change a secret.
4. **Secrets**, under these names. Use the environment variable name as the key, so `bws-env` from the dotfiles loads the same project:

   | Project  | Key                | Value                                                                                  |
   | -------- | ------------------ | -------------------------------------------------------------------------------------- |
   | `<lane>` | `FLEET_LANE_TOKEN` | The lane's token: `token` in its `config/lane.json`, or what `cardd lane add` printed. |
   | `Common` | `GH_TOKEN`         | Optional. A GitHub token for `gh` and `git`, if the lane needs one.                    |
   | `Common` | `<provider key>`   | Optional. One secret for each provider key a lane's Pi needs, named as Pi reads it.    |

   Put a lane token in without printing it: `jq -r .token ~/Projects/fleet/config/lane.json | pbcopy` (or `wl-copy`), then paste it in the web vault. For a new lane, paste what `cardd lane add` printed, and never copy it into `fleet home add`.

### Where the access token lives

On the host where a lane runs, in `~/.config/bws/<lane>.token`: a file with only that lane's access token, owner-only (`chmod 600`), outside every git checkout. This is the file the dotfiles' `bws-env` reads too. The fleet refuses a token file that group or others can read, and says so in its note. A host that runs three lanes has three token files. Nothing else holds a machine-account token: not `config/lane.json`, not `cardd`, not the environment.

`bws` keeps its own login cache under `~/.config/bws/state` (`bws config state-opt-out true` turns it off). The fleet does not read or write it.

### Turning it on for a lane

Add a `bws` block to the lane's `config/lane.json` and keep the old `token`:

```json
{
  "lane": "cleo",
  "url": "ws://<cardd Tailscale address>:7420/session",
  "token": "<the old token, kept as the fallback>",
  "bws": {
    "tokenFile": "~/.config/bws/cleo.token",
    "project": "3f2b6c1e-8d4a-4e7b-9a61-2c5d0e7f9b13",
    "common": "b7a90d24-51c3-4f8e-a2d6-9e1f40c8b5a7",
    "env": { "GH_TOKEN": "GH_TOKEN" }
  }
}
```

- `tokenFile` and `project` are required. `project` is the id of the lane's project, a UUID. A project name is refused, and the error names the file and the key.
- `common` is the id of a second project to look in when the lane's project lacks the key. It must be a UUID too.
- `laneToken` is the key or the secret id of the lane token. It defaults to the key `FLEET_LANE_TOKEN`.
- `env` maps an environment variable to a key or a secret id. A secret id is a UUID, which `bws secret get` takes. Anything else is a key, looked up in the project `project` names, and then in `common`.
- A new lane with no old token: `fleet home add cleo --url <url> --bws '<the block>'`.

`bws` runs in the fleet's own process. The machine-account token goes to it in its environment, never in its arguments. Secret values stay in memory: none goes into a command line, a log, a note, `cardd`, or a file the fleet writes.

### Which source was used

Each time the fleet reads a secret from a lane that has a `bws` block, it says where the value came from, and never the value. A mate shows it as a notice when it starts. `fleet wake` prints it on stderr:

```
fleet: lane token: from bws (key FLEET_LANE_TOKEN in project 3f2b6c1e-8d4a-4e7b-9a61-2c5d0e7f9b13)
fleet: GH_TOKEN: from the environment (bws failed: bws is not on the PATH)
fleet: lane token: from config/lane.json (bws failed: the token file ~/.config/bws/cleo.token is missing or unreadable)
```

When `bws` is not installed, fails, times out (20 seconds), or lacks the secret, the fleet uses the old value: `token` in `config/lane.json`, or the variable the mate already had. When there is no old value either, a lane token stops the mate from starting, and says why. An environment secret is left unset.

### Verify before removing the old files

`fleet secrets` is the verification step. Run it on each host, from its checkout, before you remove anything. It asks Bitwarden for every secret of every lane there and prints one line each. It exits 1 when any lookup failed. `fleet secrets <lane>` checks one lane.

```
cleo: lane token: bws ok (key FLEET_LANE_TOKEN in project 3f2b6c1e-8d4a-4e7b-9a61-2c5d0e7f9b13), the same as config/lane.json
cleo: GH_TOKEN: bws ok (key GH_TOKEN in project b7a90d24-51c3-4f8e-a2d6-9e1f40c8b5a7)
```

1. On every host, `fleet secrets` ends with exit 0 and every lane token line says `the same as config/lane.json`. A line that says `different from` means Bitwarden holds another value than the file. Fix whichever is wrong before going on.
2. Restart each lane (`fleet restart <lane>`, and for main, close its pane and run `pi -c` in its home) and read its notice: each secret says `from bws`, not `from config/lane.json`.
3. Only then remove the old values. They are the `token` in each `config/lane.json`, any environment secret that the lane's shell or `.envrc` also exports, and `~/.config/fleet/<lane>.json.migrated`, which still holds the old token. After removing `token`, run `fleet secrets` again. It now says `config/lane.json has no token`, and the lane still starts. To go back, paste the value from Bitwarden into the file.

## 6. Day to day

```sh
cd ~/Projects/fleet && pi
```

Main starts, and within a minute it has brought up every lane on every host that is not running. After that:

- Main starts a mate that died, on whichever host it runs. It says so in its thread.
- A lane that starts three times in ten minutes is held, and main tells the captain once.
- A host that cannot be reached is reported once, and again when it answers.
- `lane(name, "stop")` stops a lane and holds it, so main leaves it alone. `lane(name, "start")` starts it. `lane(name, "restart")` restarts one lane, and `lane("all", "restart")` every lane that is not held, on every host. Ask main in plain words: "restart the fleet".
- Each second mate runs in its own herdr workspace, `2ndmate-<lane>`, in that host's `default` session, and continues its conversation when it starts again. Each mate names itself when it starts: its Pi session and its herdr workspace read `1stmate` for main and `2ndmate-<lane>` for a second mate. A mate still in a workspace from before, `fleet-<lane>`, is found there until it restarts. A mate in a workspace with any other label renames it to its own name the next time its Pi starts in that pane, which includes the relaunch that `/updatefleet` does. No pane closes. To see another host's workspaces in the herdr you already use, add the host once as a machine: `herdr machine add p620 --remote-session default`.

Fleet starts the herdr server when it is not running. The first herdr call that fails with `server_not_running`, such as the lane keeper's check after a reboot, starts the host's `default` server (or the session named by `HERDR_SESSION`) detached, so it outlives the process that started it, and then repeats the call. Other sessions, such as `fm-remote`, are never started or touched. The server keeps the open-file limit of the process that started it, and every pane costs it two or three descriptors, so fleet raises the soft limit to 65536, capped at the hard limit, before it starts the server. A server that something else started keeps its own limit: if that is low (1024 on most Linux logins, 256 on macOS), `run_long` fails with `tab_create_failed`. Raise the limit where the host starts its login sessions, outside this repository: `/etc/security/limits.d` on Linux, a launchd limit on macOS. Check a running server with `grep "open files" /proc/<pid>/limits` (Linux) or `launchctl limit maxfiles` (macOS).

When herdr restarts, its panes are gone. A mate whose recorded pane no longer exists counts as down: `fleet up` starts it again in a new workspace, and a missing pane never fails the host check. Workers whose panes died with the server lose their connection, and cardd opens the usual runtime-failure incident for them, which main recovers with `restart_card`.

A job's tab closes when the job finishes. Its result is in the `[fleet]` message, not in the tab.

The same commands are on each host as `fleet` (`<checkout>/bin/fleet`):

| Command                                  | Does                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `fleet status [--json]`                  | Shows each lane on this host: running, down, or stopped.                                    |
| `fleet up [lane]`                        | Starts each lane that does not run. A stopped lane stays stopped unless it is named.        |
| `fleet stop <lane>`                      | Closes the lane's workspace and holds the lane.                                             |
| `fleet restart [lane]`                   | Starts the mate again on its conversation. No lane means every lane that is not held.       |
| `fleet arrange`                          | Puts this host's herdr sidebar in order (below).                                            |
| `fleet update [--check]`                 | Updates this host's checkout and lane homes for `/updatefleet` (section 7).                 |
| `fleet cardd --root R --db D [--check]`  | Updates and restarts `cardd`'s checkout for `/updatefleet` (section 7).                     |
| `fleet home add <lane> ...`              | Makes a lane's home. It takes `--token T`, `--bws JSON`, or both.                           |
| `fleet secrets [lane]`                   | Checks what Bitwarden serves each lane here, before an old file goes (below).               |
| `fleet home memory <lane>`               | Turns on the lane's conversation memory (section 4).                                        |
| `fleet shared --content B64 \| --absent` | Makes every lane home here hold main's `captain-shared.md` (base64), or none. Main runs it. |
| `fleet wake <lane> <note> [--script N]`  | Wakes a second mate with a note, from a script (section 5).                                 |
| `fleet cost`                             | Prints this host's last-24-hour usage rows as JSON. Main reads it for its daily cost line.  |
| `fleet migrate [--undo]`                 | Moves the earlier layout into homes (below).                                                |

When a lane starts, its home moves to the commit its checkout has, unless the home has uncommitted changes.

A lane start, a restart, and a dispatch also arrange the host's herdr sidebar: workspaces that are not mates or workers first, in the order they have, then main's `1stmate` and the `2ndmate-<lane>` workspaces by lane name, each followed by its own workers as `└ <card name>` in card order. A worker's workspace carries its lane and card as herdr metadata tokens, which is how it finds its mate. A worker whose mate has no workspace on the host stays among the first workspaces, without the `└ `.

## 7. Updating the fleet

Type `/updatefleet` in main, or ask main in plain words to update the fleet (its `update_fleet` tool). It updates every host in main's `config/lane.json` to the latest `origin/main`, restarts every lane, and then restarts main. It is Firstmate's `/updatefirstmate` for the fleet. It reads `config/lane.json` each time it runs, so a host or a `cardd` entry that you added after main started takes part without restarting main. Main keeps running the extension code it loaded when it started, so an update that first brings in this flow has to be run twice, or main restarted by hand, before `cardd` is updated.

1. **Check every host first.** On each host, `fleet update --check` fetches `origin` and looks at the checkout and every lane home on that host. On `cardd`'s host, `fleet cardd --check` looks at `cardd`'s checkout and its database the same way. Any of these stops the whole update before anything changes: a host that cannot be reached, a checkout that is not on `main`, uncommitted changes in a checkout or a lane home, commits in either that are not on `origin/main`, or a missing `cardd` database. Main reports each problem with its host and path. Nothing is pulled, and no mate restarts. Fix what it names, then run the update again.
2. **Update each host in turn.** `fleet update` checks again, fast-forwards the checkout to `origin/main`, runs `npm ci` when `package-lock.json` changed, builds the board, and moves every lane home on that host to the new commit. It never forces, merges, or stashes, and it never touches a home's `config/`, `data/`, or `state/`. A failed pull, install, or build stops the update there: no mate restarts, main keeps running, and the report says which hosts were already updated. Run the update again once the cause is fixed. A host that is already current is rebuilt, so a rerun converges.
3. **Update cardd**, when main's `config/lane.json` has a `cardd` entry (section 4). Main asks `cardd` which commit it runs. On `cardd`'s host, `fleet cardd` fast-forwards its checkout to `origin/main` and builds it, as for a host. When the code that `cardd` runs differs from the new commit in `packages/cardd`, `packages/protocol`, or `package-lock.json`, or `cardd` cannot say which commit it runs, it backs up the database to a timestamped copy next to it, such as `~/.fleet/cards-backup-2026-10-21T14-22-33Z.db`, and runs the `restart` command. `cardd` applies pending migrations itself when it starts, which is the supported way. Main then waits up to a minute until `cardd` answers on the new commit. When it does not, the update stops: no mate restarts, main keeps running, and the report names the backup. Read `cardd`'s log (`~/.fleet/cardd.log`), fix the cause, and run the update again. When `cardd`'s code did not change, it keeps running.
4. **Restart every lane**, on every host, as `lane("all", "restart")` does. A held lane stays held. Each mate continues its conversation. A host that refuses to start its mates, such as one that lacks a tool, leaves them down and the update goes on.
5. **Arrange every host's sidebar**, with `fleet arrange` on each host, whether or not a mate started there. A host that cannot arrange is reported by name and does not stop the update.
6. **Report and restart main.** The report names each host with its old and new commit, whether packages were installed, and the lane homes it moved, then `cardd`: its checkout's commits, the backup, whether it restarted, and its schema version before and after the migrations. Then it names each lane's restart, each host's sidebar, and whether the board changed. Main tells you the outcome, and when that turn ends it restarts on its own conversation, so the report stays in it.

Main restarts itself only when it runs in a herdr pane. Otherwise the report says so: restart it with `pi -c` in its home.

`cardd` reads the board's files from disk at each request, so a new board needs no restart. Without a `cardd` entry, the update does not touch `cardd`, and when it changes `packages/cardd` or `packages/protocol`, the report says that `cardd` still runs the old code.

A mate that gets a message from `cardd` that it cannot read, as when `cardd` runs other code, does not crash. It says so once in its conversation and keeps reconnecting, so the update can bring `cardd` and the mates back onto one commit.

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
