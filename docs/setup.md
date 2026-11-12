# Setup

This sets up the fleet on hosts that share a Tailscale network. One host runs `cardd`. Every host that runs mates or workers has a checkout of this repository.

The captain's routine is one step: open a terminal in the fleet repository and run `pi`. That Pi is main. Main brings up the rest of the fleet and keeps it running.

## How the pieces fit

- **Main's home is this repository.** `.pi/extensions/fleet.ts` loads the fleet extension, `/calm`, and conversation memory. `.pi/settings.json` starts Pi on the `orchestrator` tier. `AGENTS.md` holds the standing instructions. Main's private files are in `config/`, `data/`, and `state/`, which git ignores.
- **Each second mate's home is a git worktree of this repository**, at `<repo>.worktrees/lane-<lane>`, with its own private `config/`, `data/`, and `state/`. A mate is `pi` run in its home. On a host that does not have main, the checkout there plays the same part: it is the root of that host's lane homes.
- **A lane home is a folder with `config/lane.json`.** Pi started anywhere else loads none of this. A worker in a worktree of this repository gets only the extension that dispatch passes with `-e`, and needs no installed packages.
- **cardd is not part of main.** It runs under launchd on one host, from its own checkout. `/updatefleet` is the normal way to update and restart it (section 7). Main may also restart it on its host when a task needs it, and checks its log after (`~/.fleet/cardd.log`). Second mates and workers never start, stop, or restart it.

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

A command that the fleet runs on another host goes through that host's transport, so it gets the `PATH` of a non-interactive SSH session. On macOS that session has no `/opt/homebrew/bin`. The fleet appends `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, and `/usr/local/sbin` to the `PATH` of such a command when they exist and are not in it already, so Homebrew's tools work there with no change to the host. Set `FLEET_TOOL_DIRS` to a colon-separated list in the environment of a mate or of `cardd` to name other directories. Anything else must already be on the `PATH` of a non-interactive SSH session.

The `gh` login check runs only when `fleet up` or `fleet restart` is run by hand and in `update_fleet`. Main's once-a-minute lane pass runs `fleet up --maintenance`, which skips it, so a slow GitHub cannot mark a host failed. Only a definite logged-out verdict refuses. A timeout or any other unknown verdict prints a warning on stderr and does not refuse.

Conversation memory is checked for every home on the host whose `config/optchat.json` does not say `"enabled": false`. The profile that the file names must have its `AGENTS.md` and `config.json`. Without them the memory cannot start, and the mate would crash-loop. OptChat itself ships in this repository, so there is nothing to install for it.

The fleet checks all of this on each host before it starts a mate, and before `/updatefleet` changes anything:

- `fleet up` and `fleet restart` print every problem of the host, one on each line, then exit without starting a mate. Each line names the tool, the host, and the fix. Main runs `fleet up` on every host when it starts and every minute after, so it tells the captain about such a host.
- `fleet update --check` and `fleet update` report the same problems as a refusal. `update_fleet` and `/updatefleet` check every host in `config/lane.json` first, over its transport, and stop before they pull, build, or restart anything. The refusal lists the problems of every host at once.

The check does not test that the cardd host is reachable over Tailscale. Mates reconnect to `cardd` by themselves while it restarts, so a mate must start when `cardd` is down, and a reachability test would be slow and flaky.

`yazi`, `nvim`, and `fzf` are optional. They are for the Files tab (see [The Files tab](#the-files-tab)). A host without them starts its mates and shows the Files tab as a plain `nvim` or `vim` folder view, or, with no editor either, prints one line that says what to install. The tab is tested with `yazi` 26.5.6 and `nvim` 0.12. Yazi's `ya` command must be on the `PATH` next to `yazi`. `fzf` is only the picker behind `g p` and `g w`, which say so when it is missing. Install them from your package manager or, on a host with no nix, from the release binaries: https://github.com/sxyazi/yazi/releases.

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

`--hosts` names the hosts that `cardd` reaches over SSH, in the same form as `hosts` in main's `config/lane.json` (section 4). A host that is not listed runs here. `cardd` uses them to read each project's GitHub repository from a clone (section 3). The SSH session must run without a prompt, so use a key that `cardd`'s launchd job can use.

On macOS, run it under launchd with `KeepAlive` so it restarts after a crash or a reboot, as the job `dev.fleet.cardd` in `~/Library/LaunchAgents/dev.fleet.cardd.plist`. The board is then at `http://<NAME>:7420/`.

Set `ProcessType` to `Interactive` in the plist, next to `KeepAlive`:

```xml
<key>KeepAlive</key>
<true/>
<key>ProcessType</key>
<string>Interactive</string>
```

Without it, launchd applies light resource limits (`launchd.plist(5)`): it throttles CPU and I/O, and `cardd` ran below the Docker VM and the agents it serves. `Interactive` gives it normal priority. The plist is written by hand, so nothing in this repository rewrites it. `/updatefleet` pulls code and runs `cardd.restart` (`launchctl kickstart -k`), which restarts the job without re-reading the plist. A plain kickstart does not reload launchd arguments. To apply a plist change, edit the file, then run `launchctl bootout gui/<uid>/dev.fleet.cardd`, and after it `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/dev.fleet.cardd.plist`. Check it with `launchctl print gui/<uid>/dev.fleet.cardd | grep -i processtype`.

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

`/updatefleet` updates and restarts it (section 7), once main's `config/lane.json` names it (section 4). `cardd` answers `GET /api/version` with the commit its code runs and its database's schema version, so the update knows whether it runs old code.

### A public link through Cloudflare Access

The board has no login of its own, so a public link needs a gate in front of it. `cardd` can serve the board at a public host name when a Cloudflare tunnel carries it there and Cloudflare Access signs the owner in. It is off unless all four values are set, and tailnet use does not change.

`cardd` takes four values, set together or not at all:

```sh
--public-host board.example.com \
--access-team myteam.cloudflareaccess.com \
--access-aud <the 64 hex characters of the application's AUD tag> \
--access-email owner@example.com
```

`--access-team` is the team domain of the Access login, `--access-aud` is the AUD tag on the application's Overview page, and `--access-email` is the one person who may open the board. A partial or malformed set stops `cardd` at start and says which value is wrong, and so does a `--hostname` that is the public host. Add them to the command in the launchd plist, then `launchctl bootout` and `launchctl bootstrap` the job (the plist change does not reach a `kickstart`).

The tunnel must send the public host's own Host header, and nothing may rewrite it. In the tunnel's ingress, point the public host at `cardd`'s tailnet address and leave `httpHostHeader` out:

```yaml
ingress:
  - hostname: board.example.com
    service: http://<tailnet ip>:7420
  - service: http_status:404
```

The Access application must cover the same host name, with a policy that allows only the owner's email. `cardd` does not trust the tunnel or the DNS record. It checks the `Cf-Access-Jwt-Assertion` header of every request for the public host, so a request that reaches it without a valid token gets a 403 and no board content. A request with another Host that came through Cloudflare is refused too, so a tunnel that still rewrites the Host header shows nothing. The public host serves the board only: pages, data, actions, and the live socket. It does not serve `/call`, `/session`, or `/api/health`.

To check it, open the public link and sign in: the board loads, a card changes without a reload, and an answer goes through. On the host, `curl -i -H 'Host: board.example.com' http://<tailnet ip>:7420/api/board` must answer 403, and so must a request with the tailnet name as its Host and `-H 'Origin: https://board.example.com'`. `cardd` prints `cardd serves the board at https://board.example.com to ...` at start, and a log line `public host refused a request: <reason>` once a minute for each reason that it refused. To roll back, remove the four values and restart `cardd`: the public host then gets a 403 as before.

## Process containment

Fleet tracks every process a worker starts, so that `close`, a worker restart (`restart_card` replace) kill the whole tree, even processes that detach, double-fork, `setsid`, run from `/tmp`, or clear their environment. It picks a backend on each host from what the host can do, never from its name:

- `systemd`: Linux with a systemd user session (`systemctl --user` works and `busctl` exists). Each worker's Pi and its children are moved into a transient scope named `fleet-worker-<session>-<hash of the worktree path>.scope`. Close and replace stop the scope's whole cgroup (TERM, then KILL after 5 seconds). Over ssh with no login session, enable lingering once: `loginctl enable-linger <user>`.
- `cgroup`: Linux without a systemd user session, but with a writable cgroup v2 subtree for the user. Same behavior through a child cgroup and `cgroup.kill`.
- `sweep`: everything else, including macOS today. Close stops the worker's process group and sweeps processes whose cwd or command line is inside the worktree. Processes that left both are not found. A launchd coalition backend needs herdr to start the pane inside a per-card launchd job, and herdr does not offer that yet.

A failure to attach containment fails the dispatch or restart, and a failure to confirm cleanup fails the close or restart, so nothing starts or finishes with processes left uncontained. Retry the operation once the host is reachable.

On the `systemd` and `cgroup` backends, the tab of a `run_long` job joins the worker's scope or cgroup before the job's command runs, so a server that a job detached stops with the worker. When the host cannot say whether that unit exists, the job does not start and `run_long` fails. The reasons are in [code.md](code.md#process-containment).

A host-shared no-mistakes daemon is not a worker's process, even when a worker started it. `no-mistakes axi run` starts the daemon when none runs, and without a systemd user service or a launchd agent that owns it, the daemon is a child of that worker: it sits in the worker's scope or cgroup, and its working directory is the worktree. Every pipeline on the host uses it, so `close` and a worker restart never stop it. Before they stop a worker's processes, they look for a daemon that vouches for itself: a process that runs `<path>/no-mistakes daemon run --root <root>`, whose root is a folder of this user outside the worktree and whose `<root>/daemon.pid` names that very process. A daemon that started less than a minute ago has not always written that file yet, so it also counts while the file is missing or names no process that runs. A pid file that names another live process, or an older process without a matching pid file, does not vouch for it. A daemon whose executable or root is inside the worktree belongs to the worker and stops with it, and so does a process that only has the same name. Fleet moves the daemon and every process under it (its log sink and the steps of its runs) out of the worker's scope or cgroup into one host scope or cgroup named `fleet-host-no-mistakes`, then stops the rest. The cleanup by working directory skips them too. `close` says `Kept shared services:` and names each daemon it moved. On the `sweep` backend a daemon is already outside the worker's process group, because no-mistakes starts it in a session of its own. If a daemon were inside the group, the containment cleanup of close and restart fails, names its pid, and signals nothing.

The cleaner owner of the daemon is the host. Prefer starting it once from the host's own login with the daemon start command of no-mistakes, which installs it as a user service. Agent maintenance follows the scoped approval and evidence requirements in [worker rule 9](../packages/extension/prompts/worker.md#rules), coordinated by the [mate](../packages/extension/prompts/mate.md). Main owns rollout and must arrange a supported worker reload before maintenance so the executing worker uses the updated prompts and guard. Fleet's cleanup only preserves shared daemons; it does not administer them.

## Scratch space and the disk alarm

A host's `/tmp` can be a memory filesystem with a fixed number of files. On p620 it is a tmpfs with 1,048,576 inodes. It ran out on Nov 9 and broke test runs with `ENOSPC`, and it reached 96% again after that. So the fleet keeps its scratch space on disk, bounds it, and tells main when a filesystem fills.

**The folder.** `~/.fleet` on each host, the folder that already holds `cards.db` and `app`. `FLEET_HOST_DIR` changes it. The fleet adds three things under it:

- `scratch/c-<N>/` is card N's folder, with `tmp/` inside it. When the card is closed, the folder is renamed `scratch/c-<N>.closed-<epoch seconds>`, and its `tmp/` is gone.
- `node-compile-cache/` is the Node compile cache.
- `tmp-scratch/` holds the old `/tmp/fleet-c-<N>` folders that close moves to disk (see "The old path" below).

The folder also holds `host.json`, the one place where you set anything for the host (see "Host settings" below). It is yours: the fleet never writes it, and `/updatefleet` never touches it.

**What fills `/tmp`.** Two things, measured on p620 on Nov 10. Workers' evidence and scratch folders held 513,000 of the 618,000 inodes that `du` counted, in 427 `/tmp/fleet-*` folders (`/tmp/fleet-c-1300` alone had 88,000). The Node compile cache held about 335,000 more, which is what main's hand prune freed. Pi (`cli.js` and its extension loader, jiti), `tsc`, `eslint`, and `prettier` each call `module.enableCompileCache()` with no directory, which means `$TMPDIR/node-compile-cache`. An entry's name comes from the source path and content, so every worktree and every scratch copy of the repository adds new entries, and Node never removes one. `cardd` does not enable it. Nothing in this repository set it.

**A worker's environment.** Dispatch makes `scratch/c-<N>/tmp` on the worker's host and starts the worker's herdr workspace with three variables (`herdr workspace create --env`):

| Variable             | Value                                         |
| -------------------- | --------------------------------------------- |
| `FLEET_SCRATCH`      | `~/.fleet/scratch/c-<N>`, the evidence folder |
| `TMPDIR`             | `~/.fleet/scratch/c-<N>/tmp`                  |
| `NODE_COMPILE_CACHE` | `~/.fleet/node-compile-cache`                 |

Pi, its extension cache, the worker's shell tools, `mktemp`, `npm`, `tsc`, `eslint`, and Chromium profiles then write on disk. A `run_long` job tab does not inherit the workspace's variables, so the extension passes the same three to the tab (`herdr tab create --env`). The worker contract tells the worker to put reports and evidence in `$FLEET_SCRATCH`. The end-to-end suite keeps its run folder in `/tmp` on purpose (`e2e/support/run-root.ts`: a short path for socket files) and removes it when it ends, also after a failed or killed run.

**A mate's environment.** `fleet up`, `fleet restart`, and the relaunch after `/updatefleet` start Pi with `NODE_COMPILE_CACHE` set to the same cache. A main that the captain starts by hand does not get it: put `export NODE_COMPILE_CACHE="$HOME/.fleet/node-compile-cache"` in the shell profile that starts it.

**A closed card.** When `close` has stopped every attempt of the card and cardd has recorded the close, it removes the card's `tmp/` and renames the card's folder to `c-<N>.closed-<epoch seconds>`, once for each host where it stopped an attempt of the card. The name is the mark: there is no file. A card with nothing but `tmp/` leaves no folder. A close that fails leaves the folder as it was, still `c-<N>`. The evidence stays under the closed name for 7 days after the close, then it goes. A folder called `c-<N>` is never removed, however old. Dispatching the card again brings its latest closed folder back as `c-<N>`, with its evidence and a new `tmp/`. A card that is closed while its host is unreachable, or when the host's scratch step cannot run, keeps its folder as `c-<N>`, and the close says so.

**The old path, `/tmp/fleet-c-<N>`.** A worker that started before the folder above existed, a worker on a host that has not been updated, and the worker contract's fallback all still write to `/tmp/fleet-c-<N>`. On a host where `/tmp` is a memory filesystem, that folder fills it, and nothing used to move it. Now `close` also moves it, right after the step above, once for each host where it stopped an attempt of the card:

- It checks that no live process holds the folder, copies it to `<root>/fleet-c-<N>` on disk, checks the copy against the original by contents, renames the original aside, checks that no live process holds the renamed original, copies once more from it (so a late write is not lost) and checks that, puts a symlink at `/tmp/fleet-c-<N>`, and only then deletes the renamed original. When a step fails after the rename, or the move is stopped there (a timeout, a lost connection), the original goes back to its path, and when something made that path again meanwhile, the original stays beside it and the close names where. Nothing is deleted before a verified copy exists. The symlink resolves to the same files, so every path that a report or a task names still works.
- `<root>` is `tmpScratch` in the host's `host.json`, and when that is not set, `tmp-scratch` under the host folder (`~/.fleet/tmp-scratch`). It is never under `scratch/`, because the tidy deletes there. Nothing deletes the moved folders. A name that is taken gets `.1`, `.2` and so on, and is never merged into.
- A folder is skipped, and the close names it and the reason (`Scratch left in /tmp: ...`), when a live process holds it (its working directory, an open file, or a mapped file; read from `/proc`, or with `lsof` where there is no `/proc`), when it cannot tell (no readable `/proc` and no `lsof`), when it holds a file of another user or a folder this user cannot write (a container left root-owned files, for example), when `rsync` is missing, or when the copy fails or does not match. A skipped folder is left as it was, and the close is not a failure. A path that is already a symlink, or that does not exist, is not touched, so a repeat is a no-op. A move that did happen is reported as `Scratch moved off /tmp: ...`.
- It runs on the host that holds the folder, so `<root>` comes from that host's own `host.json`, whoever closes the card: main on another host over ssh, or a second mate on that host.
- `fleet scratch --move N` runs the same move for card N by hand, for a card that closed while a process held its folder. Run it only for a closed card.

**Host settings.** `host.json` in the host folder (`~/.fleet/host.json`) holds the settings of one host. It is read on that host, by the code that runs there: the move that `close` runs, and `fleet scratch`, which the alarm runs. So one value applies the same way when main closes a card on another host over ssh, when a second mate on that host closes one, when you run `fleet scratch --move` by hand, and in the alarm. An environment variable cannot do this: a mate's process, a second mate's process, and the non-interactive ssh session of the host each have their own environment, and the move and the alarm would read different ones. Nothing in a lane's `config/lane.json` is involved, because every lane has its own copy of that file and the host has one disk.

| Key          | Meaning                                                                            | Default                |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------- |
| `tmpScratch` | The absolute path of the folder that close moves old `/tmp/fleet-c-<N>` folders to | `~/.fleet/tmp-scratch` |

On p620, `/tmp` is a memory filesystem, and the old scratch goes to `/data/tmp-scratch`, on the `/data` disk, instead of under `~/.fleet`. Run this once on p620, from main or by hand:

```sh
ssh p620 'cat > ~/.fleet/host.json' <<'JSON'
{ "tmpScratch": "/data/tmp-scratch" }
JSON
ssh p620 '~/.fleet/app/bin/fleet scratch'
```

The check prints a line for each filesystem that the alarm watches, which includes the one that holds `/data/tmp-scratch` once that folder exists, and ends with `old /tmp scratch moves to /data/tmp-scratch`. The change applies at the next close: no restart. A host with no `host.json`, or no `tmpScratch` in it, keeps the default. A `host.json` that is not valid JSON, names a setting that the fleet does not know, or gives a path that is not absolute is never half used: the move leaves the folder in `/tmp` and the close says `Scratch left in /tmp: ... host.json is not usable: ...`, and `fleet scratch` exits with the same message, so the alarm names the host as unreadable. The move makes the folder when it is missing, with its parents.

**The tidy.** Main asks every host once an hour, with its minute check, to run `fleet scratch --tidy`. It removes compile cache files that nothing has written for 2 days. It removes each closed folder whose own name is 7 days old: it renames the folder to `.removing-<pid>-<id>`, then deletes it. It deletes the `.removing-*` folders that a crashed tidy left. It looks only at real folders with a closed name and never follows a link, and it never touches `c-<N>`, so it cannot take the folder of a card that dispatch is reopening. It is safe to run at any time and by hand.

**The alarm.** Each minute, main reads the use of the filesystems that hold `/tmp`, the temp folder, `~/.fleet`, and the folder that close moves old scratch to (`tmpScratch` in `host.json`) on every host (`fleet scratch --json`). When a filesystem passes 75% of its inodes or of its space, main gets one message that names the host, the filesystem, the percentage, and the five largest directories (by inodes for an inode alarm, by space for a space alarm). The directories come from every watched root on that filesystem together, so when `/tmp` and `~/.fleet` share a disk, the message can name `~/.fleet/scratch` or `~/.fleet/node-compile-cache` and the line reads `Largest under /tmp, ~/.fleet`. It says it once for each crossing. It says it again only after the filesystem has dropped below 75% and crossed it again. Main's session file is the record of what it has said: the message is in the file, and a `fleet-disk-cleared` entry in the file marks the use dropping below 75%. A restart that continues the session does not repeat the alarm, with one exception. Pi writes a brand-new session's file only when its first user or assistant message exists, so a main that is killed after it said the alarm but before that first message was written has no session file to continue, and says the alarm once more after the restart. That is a repeat, never a loss. A message that Pi could not write into the file is said again on a later check, and a cleared entry that it could not write is tried again. A new session (`/new`) starts with nothing said, so a crossing that is still over 75% is said again in it. Main says the alarm only while it is idle, so a turn that runs for a long time delays the alarm until it ends, and the captain stopping a turn cannot drop it. If the host cannot list its largest directories, main waits and asks again on the next checks. After 3 failed tries it says the crossing once without the directories, and the message says that the listing could not be read, because an alarm without the list is better than none. The check runs even when the host's lanes cannot be started. A host whose use cannot be read is named once, and again when it works.

## 3. Lanes and projects

Run these once on the `cardd` host. The host names are the fleet's own: `maverick`, `p620`, and `cnp-devvm` for the CNP dev VM. They are the names in `cardd`'s `--hosts`, in `--clone`, and in main's `hosts`. The VM's machine hostname, `cx-devvm-01`, is never used in fleet settings.

Check the checkout against the running `cardd` first:

```sh
curl -s http://<cardd address>:7420/api/version; echo
git -C ~/.fleet/app rev-parse HEAD
```

The two commits must be the same. Every command below opens `cards.db`, and opening it applies the pending migrations. A checkout newer than the running `cardd` would migrate the live database under it. So every `cardd` command except `serve` refuses a database whose schema is older than the checkout's migrations, and says `<file> is at schema N and this checkout has M`. Update `cardd` first (`/updatefleet`, section 7). Add `--migrate` only when you mean to migrate the database from this checkout, such as while `cardd` is stopped. A database with no schema yet is new, and needs no flag.

```sh
$CARDD lane list --db ~/.fleet/cards.db
$CARDD lane add main --db ~/.fleet/cards.db --home ~/Projects/fleet
$CARDD lane add cleo --db ~/.fleet/cards.db --home /path/on/its/host --parent main
$CARDD lane home cleo /new/path/on/its/host --db ~/.fleet/cards.db
$CARDD lane remove cleo --db ~/.fleet/cards.db
$CARDD project list --db ~/.fleet/cards.db
$CARDD project add web --db ~/.fleet/cards.db --delivery no-mistakes \
  --clone maverick=/Users/me/fleet-projects/web --clone p620=/home/me/fleet-projects/web \
  --hosts '{"p620":["ssh","p620"]}'
$CARDD project clone web p620=/new/path/on/p620/web --db ~/.fleet/cards.db
$CARDD project unclone web maverick --db ~/.fleet/cards.db
$CARDD project remove web --db ~/.fleet/cards.db
$CARDD project yolo web on --db ~/.fleet/cards.db
$CARDD project repo web acme/web --db ~/.fleet/cards.db
$CARDD project delivery web direct-PR --db ~/.fleet/cards.db
$CARDD card delivery 125 direct-PR --db ~/.fleet/cards.db
```

- `lane add` prints the mate's token. Never put it in a command line. Send it to a private file and pipe that into the host (section 5): `( umask 077; $CARDD lane add cleo ... > ~/.fleet/cleo.token )`. The token is a function of the lane name and the database's key, so it does not change for as long as the lane exists.
- `--parent main` makes a lane a second mate. `cardd` makes its standing lane card, which is how the board shows the lane, and where main's comments to the lane and its scheduled wakes land. Main can then reach the lane's cards and steer it. A lane added without `--parent` is the root lane, main. It has no lane card, and main cannot comment on it or reach its cards. A fleet has exactly one root lane, and it is main to `cardd`: it has main's powers, such as the whole board, every schedule, and the captain's summons. `cardd` refuses a second root lane and names the one that exists, so give every second mate a parent. A database that already holds two root lanes fails to open, unchanged, because the migration that adds this rule cannot choose one of them: leave one before `/updatefleet`.
- A lane's `--home` is informational: `cardd` never uses it, and only `lane list` shows it. `lane home <name> <path>` corrects it, for a lane whose home moved. The path must be absolute.
- `lane list` and `project list` print one line for each lane or project: a lane's parent, mate state, lane card, and home, and a project's delivery mode, yolo flag, repository, and clones. Adding a lane or a project whose name exists is refused, naming the list command.
- `lane remove <name>` takes back a lane that was added by mistake or never used: its row, its mate's token, its lane card, and its schedules. It refuses an unknown lane, a lane that is the parent of another, a lane whose mate is not `exited` (stop it first: `lane(<lane>, "stop")` in main), and a lane with open cards. It also refuses a lane that ever worked a card or has incident records, because entries are append-only: the history keeps the lane. It never touches the lane's home on disk: remove that with `git worktree remove <home>` on its host.
- Put every project's clone at `~/fleet-projects/<project>` on every host, registered as an absolute path: `/Users/me/fleet-projects/web` on macOS, `/home/me/fleet-projects/web` on Linux. Dispatch puts each worker's worktree beside it, in `~/fleet-projects/<project>.worktrees/`, so all of the fleet's working copies of a project live in one folder that nothing else owns. Never put a clone inside a lane home or inside another repository.
- `project add` reads the project's repository from the `origin` remote of a clone, unless `--repo` gives it, and then says what it did: `<name>: repo <owner>/<name>`, or `repo not set` with what to do. It reads a clone on the host named in `--hosts`, through that host's transport, in the form of `cardd serve --hosts`. A host that `--hosts` does not list is read on the `cardd` host itself, so a `--clone p620=...` needs `--hosts '{"p620":["ssh","p620"]}'` as above, or `--repo acme/web`. Without either, the repository stays unset until `project repo <name> <owner>/<name>`, or until `cardd serve` starts with the right `--hosts`, which fills a missing repository at each start.
- A project's clone is a normal clone of the repository on that host. Dispatch creates each worker's worktree next to it, in `<clone>.worktrees/`.
- To move a clone, move it, run `git worktree repair` with the paths of its worktrees, then run `project clone` with its new path. Workers that already run keep their worktrees, and close still finds them.
- `project unclone <name> <host>` removes a host's clone from the registry only. It never deletes files. The host stops appearing in project hosts, clone refreshes, close sync, and dispatch choices. It refuses an unknown project, a missing clone, or open attempts on that host, naming their cards. Removing the last clone also requires that no open card uses the project. Its output says when the last clone was removed.
- `project remove <name>` removes a project and all its clones from the registry, never files on a host. It refuses an unknown project or any open card that uses it, naming those cards. Closed cards keep their project name and history.
- Use the same host names in `--clone` that mates pass to `dispatch`.
- A project's yolo flag is the captain's standing merge authority: with it on, a mate tells the worker to merge a PR of that project with green checks, without asking the captain. The captain can set it with `project add --yolo` or `project yolo <name> on|off`, or tell main to set or clear it with `project_yolo(project, on)`. Main never changes it on its own initiative or on a second mate's request. Second mates and workers cannot change it. Destructive, irreversible, or security-sensitive merges still need the captain's words with yolo on.
- `project delivery <name> <mode>` sets the delivery mode (`no-mistakes`, `direct-PR`, or `local-only`) that ship cards created from then on take. Cards that already exist keep the mode they recorded. `card delivery <number> <mode>` changes the recorded mode of one open ship card. It refuses a closed card, a card that is not a ship card, and a card with a live worker, whose task already named its mode. For such a card, a mate dispatches with `delivery=<mode>` and `replace=true`, which starts its worker over with the new mode. No mate tool changes a project's default.
- Workers report their PR URL with `report(pr=<full https URL>)`, and their merge with `merged=true`. `cardd` never queries GitHub to discover a PR or confirm a merge. Close trusts the worker's report. Workers still check required CI before merging under the captain's authority or yolo.
- `project repo <name> <owner>/<name>` sets the project's repository metadata, also accepted as `--repo` on `project add`. Missing metadata can be read from a clone's `origin`; it is not needed to discover or confirm a PR.
- The fleet keeps clones current with their `origin`, as Firstmate did. Dispatch fetches first and branches from `origin/<base>`, and refuses when the fetch fails. When main starts, and after `close` ends a ship card, each clone is fetched, branches whose remote branch is gone are pruned, and a clean base branch is fast-forwarded. A clone with another branch checked out, a diverged base, or uncommitted changes while it is not level with `origin` is left alone and reported as `STUCK`. A base branch level with `origin` that holds uncommitted files is reported as up to date, with the files left alone. A clone that is a fleet home, such as main's checkout, is only fetched: update it with `/updatefleet` (section 7).
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
- `hosts` names the hosts that main reaches over SSH. A host that is neither listed nor this lane's own host has no transport: the fleet never runs its commands here, and says `no transport for <host>`. `roots` is each remote host's checkout, and defaults to `~/.fleet/app`. A worker that the lane starts on a remote host loads the extension from that checkout (`<root>/packages/extension/src/index.ts`), not from the lane's own home, which the other host does not have. Set `roots` for each remote host where the checkout is not at `~/.fleet/app`. Without it, the fleet looks only in `~/.fleet/app` of that host, and a dispatch there refuses when the extension is not in it.
- `cardd` tells `/updatefleet` how to update `cardd` (section 7). `host` is the host that runs it, `local` by default or a name from `hosts`. `root` is the checkout it runs from, and `db` its database, both on that host, where `~` is that host's home. `restart` is the command that restarts its service on that host: for launchd, `launchctl kickstart -k gui/<uid>/<label>`, with the uid from `id -u`. Main runs the same command when it restarts `cardd` for a task. Without `cardd`, the update leaves `cardd` alone and says when its code changed.
- `workerArgs` are extra Pi arguments for main's workers. A `--model` in them picks the workers' model. Without one, workers start on Pi's global default model, `defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json` of the host where the mate runs. A worker never takes its model from its folder, so a worker in a worktree of this repository does not run on the mates' tier. A dispatch that names a `model` overrides the model from `workerArgs` or the global default for that one worker ([code.md](code.md#lanes-and-homes)).
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

Make a second mate in four steps. The first runs on the `cardd` host, the next two on the host where the mate runs, and the last in main. Run `bin/fleet` from that host's fleet root: `~/.fleet/app` on every host except main's, where it is the captain's checkout, `~/Projects/fleet`. That checkout is the root of the host's lane homes, they share its `node_modules`, and it is the one main runs `fleet` from on a remote host (`roots` in section 4). Never use a project clone of this repository, such as `~/fleet-projects/fleet`: the home would be made beside that clone, where no host looks for lane homes.

```sh
( umask 077; $CARDD lane add cleo --db ~/.fleet/cards.db --home <the home on its host> --parent main \
    > ~/.fleet/cleo.token )

ssh p620 "~/.fleet/app/bin/fleet home add cleo --url ws://<cardd>:7420/session --token-file - --hold \
  --worker-args '[\"--model\",\"tier/quick\"]' --host p620 --hosts '{\"maverick\":[\"ssh\",\"maverick\"]}'" \
  < ~/.fleet/cleo.token
rm ~/.fleet/cleo.token

ssh p620 '~/.fleet/app/bin/fleet home memory cleo --thinking low'
$EDITOR <fleet root>.worktrees/lane-cleo/data/charter.md     # cleo's charter, on p620
```

Then, in main, `lane("cleo", "start")`. On the host itself, the same commands run without the `ssh`: `~/.fleet/app/bin/fleet home add cleo ... --token-file - < ~/.fleet/cleo.token`.

- `home add` makes the home as a worktree of the fleet root, with `config/lane.json`. It takes the token from `--token-file`: a file, or `-` for standard input. The token never sits in a command line, where it shows in `ps` and in the shell's history, and `fleet` never prints it. `--token` is refused, with exit status 2, wherever it is on a `fleet` command line, and the message never repeats its value: use `--token-file -`, `--token-file FILE`, or `--bws`. Delete the token file once `home add` has printed the home.
- `--hold` makes the home held from its first moment. Main starts every lane that is down within a minute (section 6), and a home that is not held would get a mate as soon as `config/lane.json` exists, before its memory and charter do. That mate would run with no charter, and its memory would apply only after a restart. `home add` writes `state/stopped` first and `config/lane.json` last, so no pass sees a home that is half made. Use `--hold` whenever you do more than `home add`, and start the lane when it is ready: `lane(<lane>, "start")` in main, or `fleet up <lane>` on its host.
- `home add` converges. Each step that is done already is skipped, so it is safe to run again. If an earlier run stopped after it made the worktree, a rerun with the same options adopts that worktree and finishes it. A worktree made ahead, with `git worktree add --detach <home> HEAD`, is adopted the same way. When the home is complete, a rerun prints its path, changes nothing, and needs no token, so it can never replace a lane's settings: change its Pi arguments with `fleet home set` (below), and any other setting by editing `config/lane.json`. A folder at the home's path that is not a worktree of the fleet root is refused.
- The home's path is `<fleet root>.worktrees/lane-<lane>`. Give `--home` of `lane add` that path, and correct a registry entry that went stale with `lane home` (section 3).

The mate's own settings:

- `tier` is the optional model the mate starts on, such as `"tier/weaker-orchestrator"` (`--tier` on `home add`). Without it, the mate starts on `tier/orchestrator`. Every start and restart path uses it: `fleet up`, `fleet restart`, main's automatic lane starts, and `lane(name, start|restart)`. It must be a non-empty string.
- `args` are extra Pi arguments for the mate (`--args`, a JSON array of strings). A `--model` or `--provider` in `args` takes precedence over `tier`. `workerArgs` are for its workers (`--worker-args`), and pick their model as they do for main.
- `host`, `hosts`, and `roots` work as for main. Give a mate the transport of every other host that has a clone of a project it works on: when it closes a ship card, it refreshes the project's clone on each host, and a host with no transport is skipped with `no transport for <host>`. Main refreshes it when it next starts, and `/updatefleet` still moves a fleet home.
- `direnv` names a folder whose direnv environment the mate runs in, such as `"~/cnp"` (`--direnv` on `home add`). The mate starts as `direnv exec <folder> pi`, so it gets what that folder's `.envrc` exports, and its home stays where it is. Every start, restart, and restart of a dead mate does this. The folder's `.envrc` must be allowed (`direnv allow <folder>`). The setting does not reach the mate's workers: a worker gets that environment only from its own pane's shell, such as a shell with the direnv hook in a worktree under that folder.
- `data/charter.md` is the lane's charter, added to its role contract.

`fleet --help` lists every option of `home add` and `home set`.

On a remote host, `fleet` must work over a non-interactive SSH session, so Node must be on that session's `PATH`. Check it from main's host: `ssh p620 '~/.fleet/app/bin/fleet status'`.

You do not start second mates by hand. Main starts them, and a held one starts when main's `lane(<lane>, "start")` lifts the hold.

### Changing a lane's settings

`fleet home set <lane>` changes the Pi arguments of a home that exists, without making it again. It takes only `--args` and `--worker-args`, each a JSON array of strings that replaces the whole list. Any other option, the credentials included, is refused with a message that says so: the other settings belong to `home add`, and an existing home's are edited in `config/lane.json`. It keeps the rest of `config/lane.json` (the token or `bws` block, `hosts`, `roots`, `tier`, and `cardd`), checks the result before it replaces the file, and replaces it by rename. A mate reads its settings when it starts, so a change applies after `lane(<lane>, "restart")` in main, or `fleet restart <lane>` on its host.

The ystack lane's mate loads skills from its own scratch worktree ahead of the released install. Pi loads `--skill` paths after everything it finds by itself, and the first skill of a name wins, so the lane needs `--no-skills` (on Pi 1.5.2) and its two skill folders in order: the scratch worktree's, then the released install's. A lane home has no skill folder of its own. To set that on the existing home, whose scratch worktree is `data/ystack`, main runs this on maverick, and then restarts the lane. The paths are p620's own, so `$HOME` expands there, on p620's shell:

```sh
ssh p620 sh <<'EOF'
home=$HOME/.fleet/app.worktrees/lane-ystack
$HOME/.fleet/app/bin/fleet home set ystack --args "[\"--no-skills\",\"--skill\",\"$home/data/ystack/skills\",\"--skill\",\"$HOME/.agents/skills\"]"
EOF
```

```
lane("ystack", "restart")
```

p620's checkout must have `home set` first, so run `/updatefleet` after the change that adds it is merged. A skill folder that does not exist only logs one `skill path does not exist` warning when the mate starts, and the released skills load.

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
- Restarts are safe. Each wake records the slots it covers on its own entry, so a restart of `cardd` or of the mate repeats none of them. A wake the mate had not taken in is delivered again, at its next connect or by the two-minute chase, as any message is.

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
- `cardd` checks every 15 seconds. At the time it delivers `[fleet] scheduled message from <owner>: <text>`, with the text word for word, to the recipient. It is an ordinary message: the same resend-until-taken-in delivery applies ([Persistent wakes](wake-plan.md)), and no reply is owed. For a second mate it lands on its lane card. For main it lands on a standing card named `scheduled-messages`, which `cardd` makes the first time.
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

   Put a lane token in without printing it: `jq -r .token ~/Projects/fleet/config/lane.json | pbcopy` (or `wl-copy`), then paste it in the web vault. For a new lane, paste what `cardd lane add` printed, and never put it on a `fleet home add` command line.

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

| Command                                    | Does                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `fleet status [--json]`                    | Shows each lane on this host: running, down, or stopped.                                    |
| `fleet up [lane]`                          | Starts each lane that does not run. A stopped lane stays stopped unless it is named.        |
| `fleet stop <lane>`                        | Closes the lane's workspace and holds the lane.                                             |
| `fleet restart [lane]`                     | Starts the mate again on its conversation. No lane means every lane that is not held.       |
| `fleet arrange`                            | Puts this host's herdr sidebar in order (below).                                            |
| `fleet update [--check]`                   | Updates this host's checkout and lane homes for `/updatefleet` (section 7).                 |
| `fleet cardd --root R --db D [--check]`    | Updates and restarts `cardd`'s checkout for `/updatefleet` (section 7).                     |
| `fleet home add <lane> ...`                | Makes a lane's home. It takes `--token-file F\|-`, `--bws JSON`, or both (section 5).       |
| `fleet home set <lane> ...`                | Changes a home's Pi `--args` and `--worker-args` (section 5).                               |
| `fleet secrets [lane]`                     | Checks what Bitwarden serves each lane here, before an old file goes (below).               |
| `fleet home memory <lane>`                 | Turns on the lane's conversation memory (section 4).                                        |
| `fleet shared --content B64 \| --absent`   | Makes every lane home here hold main's `captain-shared.md` (base64), or none. Main runs it. |
| `fleet wake <lane> <note> [--script N]`    | Wakes a second mate with a note, from a script (section 5).                                 |
| `fleet cost`                               | Prints this host's last-24-hour usage rows as JSON. Main reads it for its daily cost line.  |
| `fleet scratch [--tidy] [--json]`          | Prints the use of the filesystems the fleet writes scratch to. `--tidy` tidies first.       |
| `fleet scratch --open N`                   | Makes card N's scratch folder as dispatch does, and prints it and the compile cache.        |
| `fleet scratch --move N`                   | Moves `/tmp/fleet-c-N` to disk and leaves a symlink, as close does (see Scratch space).     |
| `fleet scratch --largest PATH... [--by M]` | Prints the largest directories under the PATHs together, by `inodes` (default) or `space`.  |
| `fleet files [verb ...]`                   | Runs the Files tab's explorer in this lane's home, or one of its commands (The Files tab).  |
| `fleet migrate [--undo]`                   | Moves the earlier layout into homes (below).                                                |

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

A mate or worker that gets a message from `cardd` that it cannot read, as when `cardd` runs newer code than it loaded, does not crash. It says so once in its conversation, and `cardd` logs why once. Inside a herdr pane it then relaunches itself on the same conversation at its next safe point, so it loads the code on disk, and it does so at most once every 10 minutes. A process that cannot relaunch keeps reconnecting until `lane(<lane>, "restart")` or `restart_card` replaces it. `restart_card` also replaces the disconnected worker of a paused, finished, or waiting card, and resumes nothing.

A host updates with the code it already has. A host whose checkout predates `fleet update` cannot take part, so update it once by hand: `git -C <checkout> pull && (cd <checkout> && npm ci && npm run build)`, then `fleet restart` on that host.

## The Files tab

Every mate's herdr workspace has a second tab named `Files`. It runs `fleet files` in the lane home, which starts Yazi with `nvim` as the editor. The tab is made when the mate starts, on the mate's own host, and a mate that finds the tab already there leaves it alone. When Yazi quits, the pane is a shell in the lane home, and `fleet files` brings the explorer back. Nothing about it goes through `cardd`, the board, or a link: it is a terminal on the host that has the files.

### What it shows

The lane home with `config/`, `data/`, and `state/` visible, and these places one key away:

| Key   | Goes to                                                                              |
| ----- | ------------------------------------------------------------------------------------ |
| `g h` | The lane home                                                                        |
| `g d` | `data/`                                                                              |
| `g c` | `config/`                                                                            |
| `g s` | `state/`                                                                             |
| `g r` | `data/reports/`                                                                      |
| `g p` | A picker of this host's project clones and scratch worktrees                         |
| `g w` | A picker of the worker worktrees of this lane's cards and the scratch worktrees      |
| `g k` | The skill folders. In the ystack lane, the scratch worktree's `skills/` comes first. |

`fleet files roots` prints every place that the tab knows. Some have no key: the evidence folders of this lane's cards, and the folders that the lane adds. A lane can add folders in `config/lane.json` with `"files": {"roots": ["/absolute/folder"]}`. A lane whose folders are huge can turn the previews off with `"files": {"previews": false}`: Yazi then shows only the list and the current folder.

### The guard

An edit to a tracked file is never made in place. A file opens read-only in `nvim` (`-R -M`, with the reason in the status line) when it is:

- tracked by git, or new and not ignored, in this checkout, in any lane home, or in a registered project clone on this host;
- inside a worker's worktree, which its worker owns;
- inside a released skill folder (`~/.agents/skills` or `~/.pi/agent/skills`), by the folder's real path and not by its file mode, so a skill that links into a live checkout is guarded through the link too.

An ignored file, such as anything in `data/`, `config/`, or `state/`, opens writable. A folder counts as ignored only when it holds no tracked file, so a folder with a force-added file in it is guarded whole. A binary file, or one over 2 MiB, opens as a metadata screen, with Enter and with `E`. Every file that a session opens afterwards, with `:edit` or a split, gets the same check, so a tracked file opened from a writable session is read-only too.

The keys that change files check every path that they would write or delete, not only the one under the cursor. Rename and create ask for the name in a prompt of the guard's own, then check the path that the name leads to, so `../README.md` is refused when `README.md` is tracked. Paste and link check the current folder and each file that they would make in it, because Yazi picks another name when a name is taken, and a paste of something cut from a guarded place is refused. Delete and rename check everything inside a folder, and a folder that holds a clone, a lane home, a worker worktree, or a skill folder is guarded whole, so it cannot be deleted or moved away. A refusal changes nothing and is a notice in Yazi that names the reason. `fleet files check <path>` prints the decision for a path and exits non-zero for a guarded one.

The guard needs to know the project clones of this host, which it asks `cardd` for and saves in `state/files/projects.json`. When `cardd` cannot be reached and nothing is saved yet, it cannot tell a clone from a private folder, so it treats every path outside the lane homes and the fleet checkout as guarded, and says why.

The guard is a seat belt for the captain's keys. It does not stop a program that writes the file by another route.

### Scratch worktrees

`E` on a guarded file opens the same file in the project's scratch worktree, `<clone>.worktrees/scratch`, on its own branch `scratch/<host>-<time>` made from `origin/<base>`. The scratch worktree is made the first time and kept. The fleet leaves it alone: `/updatefleet`'s check, the clone refresh, and a dispatched worker all ignore it, and lane homes do not list it. `fleet files scratch` lists each one with its branch, how far it is ahead of and behind the base, and its dirty files. `<base>` is `origin/<base>`, or the local `<base>` for a local-only project, and the scratch is made from it, measured against it, and reset onto it. `fleet files scratch reset` moves a scratch with no dirty files onto a fresh branch from the current base, but only when its branch is merged: when every file the branch changed already has the branch's content in the base, which a squash merge satisfies. The check uses only commands of the supported Git. A deleted remote branch is not evidence of a merge, so a branch that was pushed and then closed without a merge stays, and reset refuses. `P` pushes the scratch branch, and the pull request is yours to open: `gh pr create` in the scratch folder. To have a worker deliver it, press `M` and ask main (below). `E` checks the scratch copy that it opens the same way as the original, so a binary or large copy shows its metadata, and a copy that is a link to a guarded file opens read-only.

### Show, Reload, and Main

`S` types a message into this lane's mate as your own message, `M` types it into main, `R` reloads this lane's mate, and `Ctrl-r` reloads main. Each one first prints the whole text and waits. Enter sends it, Esc cancels, and nothing is typed without that Enter. You can add one line of your own before Enter. The text names the host, the absolute path, and the first 12 characters of the file's SHA-256. For a path in a scratch worktree it also names the branch, the commit, and the `git diff --stat` lines, and it never carries the file's content. A reload is typed only when herdr says the mate is `idle`, because Pi cannot reload while it works. A blocked mate is refused with the reason.

`M` needs to reach main's herdr. Set `"files": {"main": "<host>"}` in `config/lane.json`, the name of the host where main runs. Main's own lane needs no setting: it types into main on this host. When the setting names this host, or a host in the lane's `hosts` map, `M` types into main's pane. In any other case `M` posts the text as the captain's comment on this lane's newest open card, which reaches main as `[fleet] captain on c-N (in <lane>'s lane)`, and says that it did. A lane with no open card has nothing to comment on, so `M` refuses and says so.

### Skills

Skill text is edited in one place: the ystack lane. Every other lane, and every host, reads the released install, read-only. In another lane, `E` on a skill makes no scratch worktree and says so: press `M` to ask main, which routes the request to the ystack lane. In the ystack lane, `E` on `~/.agents/skills/<name>/<file>` opens `<scratch>/skills/<name>/<file>`, and the lane's own Pi, which loads that folder ahead of the release (see "Changing a lane's settings"), sees the edit after `/reload`. The lane's args list the scratch worktree's `skills/` first, so the Files tab finds the workshop from them: a `--skill` folder that is the `skills/` of a git checkout of a registered project, other than the project's clone. The tab decides by those args and not by the lane's name, so any lane whose args load such a folder can edit skills in it.

`fleet files skills` prints the winner of each skill name in this lane's Pi, where its file is, who can write it, the skills it hides, how far the scratch is ahead of and behind the base, and flags for the problems that matter: a scratch that is behind (it hides newer released text from this lane), a merged scratch branch, a skill folder that links into a live checkout, a skill in `~/.pi/agent/skills` that hides the released one of its name, and a host whose released install is older than the newest ystack tag. The mate writes `state/skills.json` when it starts or reloads, and the command reads it, so run it after the mate has started.

### Rolling it out

1. Merge the change and run `/updatefleet`. Every lane then has the new extension. Nothing in the protocol, `cardd`, or the database changes, so mates that run the earlier code keep working and reconnect as before. A lane gets its Files tab the next time its mate starts (`lane(<lane>, "restart")`), and a lane that has not restarted has none.
2. Install `yazi`, `nvim`, and `fzf` on each host, or none of them (see Prerequisites). The CNP VM has no nix, so use the release binaries there.
3. Set `"files": {"main": "<host>"}` in each lane's `config/lane.json` that should type into main's pane with `M`. A lane that does not set it uses the board comment.
4. Before a lane that holds a very large tree gets the tab for good, run `fleet files` in it by hand and note how long the first listing of its biggest folder takes. If it stalls, set `"files": {"previews": false}` for that lane.
5. In the ystack lane, nothing more is needed if its `args` already load the scratch worktree's `skills/` as in "Changing a lane's settings".

## The host's Chrome and the captain's windows

This is optional. It is for a host whose workers share one Chrome, as p620 does. The captain gets that Chrome's windows on his Mac as native windows, and workers keep driving it over DevTools on `127.0.0.1:9222`. Nothing here talks to `cardd`, and `/updatefleet` does not change it.

The pieces, all in `packages/chrome` and run through `<checkout>/bin/fleet-chrome` on the host and `<checkout>/bin/fleet-attach` on the Mac:

- **The guard** (`fleet-chrome guard`) listens on `127.0.0.1:9222` where Chrome did. Chrome moves to a port that it picks itself (`--remote-debugging-port=0`), and the guard finds it in `DevToolsActivePort` in the profile folder. While the captain types a password into a tab, the guard refuses the worker calls that read that tab and strips what he typed from the events and request bodies that workers see. A read that was let through before he typed is refused when its answer comes back after. While the guard cannot see Chrome, as when it has just started or has lost its link, it refuses those reads too and says `The browser guard is not ready`. Everything else works as before. The guard covers the shared DevTools port: it stops reads by habit and by tools that go through that port. It does not stop a worker that looks for Chrome's real loopback port on purpose.
- **Xpra** (`fleet-chrome xpra`) shows the windows of Chrome's display. It listens on one unix socket (`$XDG_RUNTIME_DIR/xpra/<host>-<display>`, mode 600) and on no network port. The Mac reaches it through `ssh <host> xpra _proxy`. It starts only when the guard answers on 9222, and it stops when the guard stops, so there is no way to attach without the guard.
- **The launcher** (`fleet-attach <host>`) checks over ssh that the guard answers, then runs the Xpra client with `--window-close=disconnect`. It checks again before every attach.

The clipboard is off. Both ends must say yes for it to work: `fleet-chrome xpra --clipboard` on the host and `fleet-attach --clipboard` on the Mac. Without the flag, each end passes `--clipboard=no` to Xpra. Turning it on makes the captain's Mac clipboard readable on the host by every process of the desktop user, workers included, so anything he copies can be read. It is a decision for each host (change the unit's `ExecStart`) and for each attach (the launcher flag).

What the captain sees: every window of the host's Chrome, including every worker's tabs, with Chrome's own tab strip and shortcuts. Closing a window, or Cmd+Q, leaves all windows and ends the launcher. Every tab keeps running on the host. Run `fleet-attach` again to come back. Two limits: the page follows the size of his window, so a worker's screenshots change when he resizes it, and text is soft on a Retina display because the host Chrome runs at device scale 1.

### Rollout on a host, in this order

The captain approves the host steps. Do them when no worker is using the browser (`board` shows it): step 3 restarts Chrome, which closes every open tab. Cookies and logins stay in the profile.

1. **Install Xpra 6.5.x on the host**, where a non-interactive SSH session finds `xpra` (on p620, `nix profile install nixpkgs#xpra`, which puts it in `~/.nix-profile/bin`). Check that the display has no window manager of its own: `DISPLAY=:99 xprop -root _NET_SUPPORTING_WM_CHECK` must say `not found`. Xpra becomes the window manager of that display.
2. **Update the checkout** on the host to a commit that has `bin/fleet-chrome` (section 7).
3. **Move Chrome and start the guard.** In the host's `fleet-chrome.service`, change `--remote-debugging-port=9222` to `--remote-debugging-port=0`, and add `rm -f <profile>/DevToolsActivePort` to its `ExecStartPre` lines. Add this unit as `fleet-chrome-guard.service`, with the checkout's real path and the real profile folder:

   ```ini
   [Unit]
   Description=Fleet shared browser guard
   After=fleet-chrome.service

   [Service]
   Environment=PATH=%h/.nix-profile/bin:/usr/bin:/bin
   ExecStart=<checkout>/bin/fleet-chrome guard --listen 127.0.0.1:9222 --chrome <profile>
   Restart=always
   RestartSec=2

   [Install]
   WantedBy=default.target
   ```

   Then `systemctl --user daemon-reload && systemctl --user restart fleet-chrome && systemctl --user enable --now fleet-chrome-guard`. Check that `curl -si http://127.0.0.1:9222/json/version` shows `x-fleet-guard: 1`, and that a worker's browser tool still opens a page.

4. **Start Xpra.** Add `fleet-chrome-xpra.service`, with the host's display, and run `systemctl --user enable --now fleet-chrome-xpra`:

   ```ini
   [Unit]
   Description=Fleet shared browser windows for the captain (Xpra)
   After=fleet-xvfb.service fleet-chrome-guard.service

   [Service]
   Environment=PATH=%h/.nix-profile/bin:/usr/bin:/bin
   ExecStart=<checkout>/bin/fleet-chrome xpra --display 99 --guard-port 9222 --xpra %h/.nix-profile/bin/xpra
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

   The unit has no `--clipboard`, so the host's clipboard stays off. Check that `ss -lxp | grep xpra` lists one socket for the display, that `ss -ltnp | grep -i xpra` lists nothing, and that `stat -c %a /run/user/$(id -u)/xpra/<host>-99` says 600.

5. **Install Xpra.app on the Mac**, the same 6.5 version (Homebrew's cask is disabled). Download `Xpra-arm64-6.5.5-r0.dmg` from https://www.xpra.org/stable/osx/arm64/ (sha1 `7438cf6e8f8295ef64769b4138f138fb783e3e25`), open it, and drag the app to Applications. If macOS says it is damaged, run `xattr -rd com.apple.quarantine /Applications/Xpra.app`. macOS may ask for permissions when the first window opens. They are the captain's to grant. Check that `ssh -o BatchMode=yes <host> true` answers with no prompt.
6. **Attach.** On the Mac, in a checkout with `npm ci` done: `bin/fleet-attach <host> --display 99`. The windows appear in a few seconds. Open a login page, click its password field, and type. In a worker's browser tool, a read of that tab must now fail with `The captain is typing a password in this tab`, and succeed again when the field is empty.

To undo: on the Mac, stop `fleet-attach` and delete `/Applications/Xpra.app` and `~/.xpra`. On the host, `systemctl --user disable --now fleet-chrome-xpra fleet-chrome-guard`, change `--remote-debugging-port=0` back to `9222` in `fleet-chrome.service`, and `systemctl --user restart fleet-chrome` (this closes the tabs again).

### What happens when something restarts

| What stops                               | What the captain and workers see                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Mac sleeps or the link drops         | The windows go. The launcher checks the guard and attaches again, after 1 s and then up to 10 s apart. The tabs are as he left them.                         |
| The captain closes a window or quits     | All windows go and the launcher ends with 0. Chrome and every tab keep running.                                                                              |
| The host's Xpra service restarts         | The launcher attaches again when Xpra is back.                                                                                                               |
| The guard stops or crashes               | Within about 4 s the host stops Xpra. Workers get no DevTools port until the guard is back. The launcher waits, and attaches by itself once the guard is up. |
| Chrome restarts                          | Its tabs are gone, as for any Chrome restart. The guard follows the new port and the new windows appear on the Mac.                                          |
| `cardd` or a mate restarts or reconnects | Nothing changes. This path never touches `cardd`.                                                                                                            |

`fleet-attach` options: `--display` (default 99), `--guard-port` (9222), `--xpra` (the client, by default the app in Applications), `--remote-xpra` (Xpra on the host, default `xpra`, a path as the host sees it, so spell out `/home/<user>/.nix-profile/bin/xpra` or quote it, because the Mac shell expands an unquoted `~` to a Mac path), `--clipboard` (share the clipboard, off by default, and only works when the host's Xpra was started with `--clipboard` too), `--ssh` (default `ssh`), and `--retry-ms` (1000). It ends with 99 when something other than the guard answers on the guard's port, and with Xpra's own exit code for a failure that waiting does not fix.

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
