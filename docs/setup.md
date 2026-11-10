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

A command that the fleet runs on another host goes through that host's transport, so it gets the `PATH` of a non-interactive SSH session. On macOS that session has no `/opt/homebrew/bin`. The fleet appends `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, and `/usr/local/sbin` to the `PATH` of such a command when they exist and are not in it already, so Homebrew's tools work there with no change to the host. Set `FLEET_TOOL_DIRS` to a colon-separated list in the environment of a mate or of `cardd` to name other directories. Anything else must already be on the `PATH` of a non-interactive SSH session.

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

`--hosts` names the hosts that `cardd` reaches over SSH, in the same form as `hosts` in main's `config/lane.json` (section 4). A host that is not listed runs here. `cardd` uses them to read each project's GitHub repository from a clone (section 3), and to reach each host's browser and run `bws` there for its logins (The browser of each host). The SSH session must run without a prompt, so use a key that `cardd`'s launchd job can use.

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

A host-shared no-mistakes daemon is not a worker's process, even when a worker started it. `no-mistakes axi run` starts the daemon when none runs, and without a systemd user service or a launchd agent that owns it, the daemon is a child of that worker: it sits in the worker's scope or cgroup, and its working directory is the worktree. Every pipeline on the host uses it, so `close` and a worker restart never stop it. Before they stop a worker's processes, they look for a daemon that vouches for itself: a process that runs `<path>/no-mistakes daemon run --root <root>`, whose root is a folder of this user outside the worktree and whose `<root>/daemon.pid` names that very process. A daemon that started less than a minute ago has not always written that file yet, so it also counts while the file is missing or names no process that runs. A pid file that names another live process, or an older process without a matching pid file, does not vouch for it. A daemon whose executable or root is inside the worktree belongs to the worker and stops with it, and so does a process that only has the same name. Fleet moves the daemon and every process under it (its log sink and the steps of its runs) out of the worker's scope or cgroup into one host scope or cgroup named `fleet-host-no-mistakes`, then stops the rest. The cleanup by working directory skips them too. `close` says `Kept shared services:` and names each daemon it moved. On the `sweep` backend a daemon is already outside the worker's process group, because no-mistakes starts it in a session of its own. If a daemon were inside the group, the containment cleanup of close and restart fails, names its pid, and signals nothing.

The cleaner owner of the daemon is the host. Prefer starting it once from the host's own login with the daemon start command of no-mistakes, which installs it as a user service. Agent maintenance follows the scoped approval and evidence requirements in [worker rule 9](../packages/extension/prompts/worker.md#rules), coordinated by the [mate](../packages/extension/prompts/mate.md). Main owns rollout and must arrange a supported worker reload before maintenance so the executing worker uses the updated prompts and guard. Fleet's cleanup only preserves shared daemons; it does not administer them.

## The browser of each host

Workers do not drive the captain's laptop. Each host that runs agents can have its own Chrome, and every card gets its own tab in the Chrome of its own host, and that tab is in a window of its own.

- A card's browser is on its own host. That is the host of its worker's attempt (the `host` that `dispatch` was given), or, for a card with no worker, the host of the mate that drives it (`host` in that mate's `config/lane.json`). The host is never an argument: a worker cannot name one, and a mate's `browser-axi` sends the host that its own lane config names. A tab stays in the Chrome that made it. A host that `--browser` does not name has no browser: `browser-axi` says `no shared browser configured on host <name>` and exits 4, and nothing opens on any other host. Tab ownership, teardown, and the hiding of secrets (below) all work for each host on its own.

- `cardd` holds the only connection to each host's Chrome (the Chrome DevTools Protocol, CDP). An agent runs `browser-axi`, a command line program in the style of `no-mistakes axi` and `lavish-axi`, and the program calls `cardd`. An agent never gets the CDP address from the program, so it cannot reach another card's tab through it. The program takes no tab id: a worker always means its own card's tab.
- `cardd` records which card owns each tab (`browser_tabs`). `open` gives the card a tab labelled `c-<id> <name>` in its page title, in a window of its own that Chrome opens in the background (it takes no focus), and loads a page in it. `back`, `forward`, `reload`, `read`, `click`, `type`, `press`, `eval`, `screenshot`, `login`, and `close` act on that tab only.
- A page cannot open a new window. `window.open` and links and forms with a `target` load in the card's own tab. A window that still appears is closed by `cardd` as soon as Chrome reports it.
- Only `http` and `https` pages can be opened. A worker cannot open `chrome://`, `file://`, or `view-source:` pages.
- `close`, a worker restart (`restart_card` replace), and a worker run that is stopped (Escape in the pane, which files a `stopped` report) close every tab of the card, in the Chrome of each host that holds one. For `close` and a restart this happens after the card's processes are stopped (see Process containment). A worker that is resumed after a stop opens a new tab. Output of `close` and `restart_card` says how many tabs were closed. A Chrome that is down does not block any of them: the output says that the tabs stay open, and `cardd` closes them the next time it connects, also after a restart of `cardd` in between. That covers the tabs of an ended card, the tab of a card whose last report is `stopped` and that no run has resumed since (this also covers a `cardd` that stopped between storing the report and releasing the tab), and a tab that a restart could not close. A card that was resumed after the stop keeps its tab. The card never uses such a tab again: its next `open` makes a new tab. The viewer's polling makes `cardd` connect, so a Chrome that comes back is cleaned up without a worker call. `cardd` records first that the card's tabs are released, and only then tells Chrome. If `cardd` cannot record it (the call to `cardd` fails), `close` does not finish and a restart does not start the new worker, so retry once `cardd` answers. A worker's own `close` while Chrome is down fails and says that the tab stays open, and the worker can call it again: once Chrome answers, that call closes the tab itself, without waiting for a viewer poll.
- The `Browser` tab of a herdr workspace is a viewer, described below.

### The browser-axi command

`browser-axi` is `bin/browser-axi`, and every fleet agent has it on its `PATH` (the extension adds `packages/extension/shims`). Any agent or script that runs in a fleet agent's shell can use it. It prints TOON like the other AXI programs, or one JSON object with `--json`, and it ends every answer with `help` lines that name the next command.

| Command                                                                                     | What it does                                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `browser-axi`                                                                               | Says whether this fleet has a shared browser and which tabs are open. It opens nothing.                                   |
| `browser-axi open <url>`                                                                    | Gives the card its own tab, in a window of its own, and loads the page. Opening again loads another page in the same tab. |
| `browser-axi back`, `forward`, `reload`                                                     | Go one page back or forward in the tab's history, or load its page again.                                                 |
| `read [--selector css] [--html]`, `click`, `type`, `press <key>`, `eval <js>`, `screenshot` | Act on the card's tab. `screenshot` writes a picture file and prints its path (`--out file` names it).                    |
| `browser-axi login [--site host]`                                                           | Fills the username and password of the site that the tab shows, from the Bitwarden Logins project.                        |
| `browser-axi close`                                                                         | Closes the card's tab, and the caller's own `Browser` viewer tab when no tab is left to show.                             |

`--card <n>` is for a mate: it names the card whose tab it drives, a card of its lane (main: any card). A worker never gives it. Without a card, a mate's call fails and says to name one.

How it reaches `cardd`: it uses the caller's own credentials, and `cardd` treats the call as that session's own. A worker's shell has `FLEET_BROWSER_URL` and `FLEET_BROWSER_TOKEN`, which the extension sets from the worker's card session (the token already sits in the worker's own launch arguments). A mate's shell has only `FLEET_BROWSER_HOME`, the lane's home: the program reads `config/lane.json` there and gets the lane token the way the mate does, from the file or from Bitwarden, so a lane token that is kept in Bitwarden never enters a mate's environment or a file. A card's tab belongs to the card, and the program has no way to name another. It prints nothing from the environment and takes no secret in `argv`. Every error, also an unexpected one, is printed on stdout as the `error` field with the exit status below, and stderr stays empty. Everything that a worker sees still goes through `cardd`'s scrub, so a stored credential does not reach stdout, stderr, the picture file, or an error.

Exit status: 0 done, 1 error, 2 usage, 3 `login` found no entry for the site (the mate was asked), 4 this fleet has no shared browser. A `click` with no selector and no point (`--x` and `--y`) is a usage error.

What it prints, beyond `result`:

- `back`, `forward`, and `reload` add `page` too, and wait for the load as `click` does. `back` and `forward` fail with `your tab has no earlier page to go back to` (or `no later page to go forward to`) when the history has no such page. The tab's first page is never an earlier page: the blank page that Chrome makes the tab with is not offered.
- `click` and `read` add `page`, the title and address of the page when the action ended, so a worker sees whether a click navigated. A `click` that starts a load of the page within a moment waits for the load to end (30 seconds at most, and the result then says that the page is still loading) before it reads them. `cardd` cleans `page` of stored values as it does `result`.
- `eval` prints the value once: a string as the string, and an object or a list as a structure, in TOON or in the JSON object. `cardd` still sends the value as JSON text, cleaned as before, and the program reads it once. A value that is not JSON text (`undefined`, or a result cut at the length limit) is printed as the text.
- `browser-axi` with no command lists the tab and offers `read`, `screenshot`, and `close` when a tab is open, and `open <url>` when none is.
- An error that needs a tab says what to run, `browser-axi open <url>`, and carries a `help` line that says it too. `login` on a host that has no `logins` in `--browser` says that logins are not set up on that host and to ask the mate, and its `help` tells the worker to report paused or blocked.
- A default `screenshot` (no `--out`) writes into a new `fleet-shot-*` folder of the temporary directory, and first removes the ones of that name that the same user owns and that are older than a day.

A fleet without `--browser`: `browser-axi` in any form says `no shared browser: this fleet has no shared browser configured: cardd was started without --browser` (an action adds `, so the browser is not available`) and exits 4. It names no other browser and does not point an agent to one. The worker prompt (rule 12) tells a worker to run `browser-axi` once on a task that needs a web page, to use it when the fleet has a browser, and to carry on without it when it exits 4.

### Where the viewer opens

The viewer (the `Browser` tab, below) runs in a herdr workspace of the host where the program that places it runs, and shows tabs of any host:

- The page does not need the captain: the first `open` of a call opens the viewer in the calling agent's own workspace (`HERDR_WORKSPACE_ID`), as a tab named `Browser` that does not take focus, and a later `open` reuses it. A worker's viewer lists only that card's tab, which is in the Chrome of the worker's own host, so it reads that Chrome on the host's loopback. The viewer refuses to stream, drive, navigate, or copy from a tab that `cardd` does not list for the caller.
- The page needs the captain: add `--captain "<why>"` to any command, such as `browser-axi open <url> --captain "the bank asks for a passkey"`. `cardd` then files a note (`c-N <name> needs the captain in its browser tab: <why>`), once for each card and reason, and raises the card's window in its Chrome (a minimized window is restored and the tab is activated), so the captain finds it in front. Where the viewer opens depends on where the captain is:
  - A card of main's lane: the note goes to main, and main's own extension opens the captain's viewer (below) in main's workspace, focused, and opens the page once: in a Sheprd browser tab when the host has its shim, otherwise in the host's default browser (see The viewer).
  - A card of a second mate's lane: the note goes to that mate. The mate's extension looks at its own herdr workspace. If it is the focused one, the captain is there: a gated viewer (below) opens in that workspace, focused, and opens the page the same way, in a Sheprd tab or the host's default browser. If it is not, the mate asks `cardd` to tell main (`browser.summon`), and main opens the captain's viewer in main's workspace. When the lane's mate is not connected, the note goes straight to main.
  - The caller's own workspace gets no viewer from a `--captain` call.

  Use it for a passkey, a one-time code, terms to accept, and a payment. The note is filed whether the call succeeds or fails: when the action is refused or fails (a screenshot that would show a credential, an `eval` refused while a login-filled field holds a value, a login that cannot fill), `cardd` still files it and the viewer still opens, and the call exits 1 with its own error and the sentence `The captain was asked to open the tab: <why>.` added. A card with no tab is not summoned, and a fleet without `--browser` is not either.

- Across hosts: a viewer shows the tabs of any host, and each tab's Chrome is on its own host. A gated viewer's picture comes from `cardd` (`browser.frame`), which reaches each host by its own transport (`--hosts` of `cardd`), so it needs nothing from the lane for a tab on another host. What the viewer reads from Chrome itself (the page size of a gated viewer, every click and key, and the whole picture and the selection of the captain's viewer) goes the way the tab's host is: a tab on the viewer's own host is read on that host's loopback, and a tab on another host is read through the transport that names that host in `hosts` of the `config/lane.json` of the lane that placed the viewer, the same SSH transport that the lane uses for everything else. Nothing is opened on the network for it: the Chrome stays on its host's loopback, and the viewer's own page listens on `127.0.0.1` only, except the captain's viewer, which listens on its host's tailnet address (The captain's viewer on the tailnet). `host` in that `lane.json` must be this machine's name in the fleet. A viewer with no transport for a tab's host says `no transport for <host>` for what it needs from that Chrome.
- A missing login entry is detected: `login` with no entry for the site exits 3, files the request for the mate as before, and opens the viewer where the captain is, the same way, so the captain can see the tab while he adds the entry. When the card's lane is not main and its mate is not connected, main is told in a second note.

Nothing opens in a workspace that is not the caller's own, the lane's, or main's. A caller outside herdr (no `HERDR_WORKSPACE_ID`) gets no viewer tab and is told so in the `view` field.

Only the captain's viewer shows a page as it is. Every other viewer is gated: a viewer in a worker's own workspace, one that main's own agent opens in main's workspace, and one that a second mate opens. A gated viewer does not take its picture from Chrome. It asks `cardd` for each picture (`browser.frame`), and `cardd` scans the page and takes the picture in one call, the way `screenshot` does, so the picture is never older than the scan. If `cardd` refuses, the page shows `Hidden: <note>` in place of the picture and no image data reaches it. The tab list comes from `cardd` too, with each title and address cleaned of stored values as `read` is. The captain's viewer is the one that main's extension starts for a summon (`--captain`): it takes its picture from Chrome, and only main's own session may ask `cardd` for its raw titles and addresses (`captain: true` from a worker or a second mate is refused). Both modes are in the next section.

Every viewer prints its mode on its first line: `Fleet browser viewer (captain): <address>` or `Fleet browser viewer (gated): <address>`. Placement reads it from the pane. A workspace has one `Browser` tab, and a summon that reaches main always ends with the captain's viewer in main's:

- no `Browser` tab in main's workspace: it is created and the captain's viewer starts in it;
- its pane is idle: the captain's viewer starts in it;
- its pane runs a captain's viewer: see [build checking and replacement](#the-link-reaches-the-captain-and-a-stale-viewer-is-replaced);
- its pane runs a gated viewer, for example because main's own agent ran `browser-axi open --card N` from its workspace: placement sends Ctrl-C to the pane, waits until the shell is idle, and starts the captain's viewer in the same pane.

A placement for the caller's own workspace, and a second mate's for its lane's, never replaces a running captain's viewer, and reuses a running gated one of the current build. A gated viewer of another build, or one that prints no build, is replaced unless a password that a viewer entered is still in a tab that the placement's session sees (see [build checking and replacement](#the-link-reaches-the-captain-and-a-stale-viewer-is-replaced)). Summons are placed one at a time.

### What a host's Chrome service must provide

The services are not in this repository. Dotfiles builds and runs them, one for each host that should have a browser: p620, maverick, and the CNP dev VM `cx-devvm-01`. The CNP VM runs Chromium, and it is live in `cardd`'s `--browser` at `cdp` `http://127.0.0.1:9222`. The fleet needs exactly this on each host:

| Item         | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display      | Linux: `Xvfb :99 -screen 0 1920x1080x24 -dpi 96 -nolisten tcp`, as its own always-on unit that Chrome starts after, and Chrome runs with `DISPLAY=:99`. macOS: Chrome runs as a login item of the user's own session, which is its display. A headful Chrome is wanted over `--headless`, because `--headless` puts `HeadlessChrome` in the user agent and some sites refuse it, and a real display is where passkey and permission prompts appear.                                                                                                                           |
| Binary       | Google Chrome stable (Chromium on the CNP VM), 136 or newer (older ones accept `--remote-debugging-port` on the default profile, newer ones refuse it).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Profile      | A dedicated, persistent user data directory that nothing else uses, mode `0700`: `~/.local/share/fleet-browser/profile` on Linux, `~/Library/Application Support/fleet-browser/profile` on macOS. Never the default profile of the account. It keeps cookies, so a login survives a restart. It belongs to its host: never copy a profile to another host, because its cookies are that host's logins.                                                                                                                                                                        |
| Flags        | `--user-data-dir=<profile> --remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --hide-crash-restore-bubble --window-size=1440,900 --window-position=0,0`. Do not pass `--no-sandbox`, `--headless`, or `--remote-allow-origins`: none is needed. On Linux the display needs Xvfb's `-dpi 96` (the Display row has it in the command): at Xvfb's default 100 dpi, Chrome renders at a device scale of 1.047, so screenshots and viewer frames come out soft and at odd sizes. Dotfiles applies it on p620, and cnp on `cx-devvm-01`. |
| Policy       | A managed policy with `PasswordManagerEnabled: false`, `AutofillAddressEnabled: false`, `AutofillCreditCardEnabled: false`, `BrowserSignin: 0`, and `SyncDisabled: true`: a file in `/etc/opt/chrome/policies/managed/` on Linux, the managed preferences of `com.google.Chrome` on macOS. Without it Chrome offers to save a password the fleet typed, and writes it to the profile.                                                                                                                                                                                         |
| CDP bind     | Chrome binds `127.0.0.1:9222` only. Chrome ignores `--remote-debugging-address`: on Chrome 155 `--remote-debugging-address=0.0.0.0` still listens on `127.0.0.1` only. That is all the fleet needs.                                                                                                                                                                                                                                                                                                                                                                           |
| No forwarder | Nothing forwards `9222` anywhere: no `tailscale serve`, no `socat` on another interface, no `ssh -L` or `-R`, no router port forward. The fleet reaches the port through the host's SSH transport, below, so nothing new is exposed on the network.                                                                                                                                                                                                                                                                                                                           |
| Reach        | `cardd` and every viewer reach the port by running `node` on the host through the host's transport (the argv in `--hosts` of `cardd` and in `hosts` of `config/lane.json`): a relay between the transport's standard input and output and `127.0.0.1:9222`. So Node 24 must be on the `PATH` of a non-interactive session of the host, as the prerequisites already say, and the transport must run with no prompt. For `cx-devvm-01` that is its IAP SSH command.                                                                                                            |
| Supervision  | `Restart=always` for Chrome and for its display, and `loginctl enable-linger <user>`, so Chrome is up with no one logged in (macOS: `KeepAlive` in a launchd agent of the user's session). Check on the host: `curl -s http://127.0.0.1:9222/json/version` prints JSON.                                                                                                                                                                                                                                                                                                       |

A restart of a host's Chrome loses its tabs. `cardd` notices, and a card's next `open` makes a new tab. A card that opens on another host, or whose old host is not in `--browser` any more, gives up its tab on the old host at once: `cardd` closes the tab in that Chrome when it can be reached again. A host whose transport is down has an unreachable browser: calls for its cards fail with `the browser on <host> is unreachable`, and a close or a restart goes on and says that the tabs stay open, as above. The other hosts are not affected.

The relay is a TCP listener on `127.0.0.1` of the machine that runs `cardd` or the viewer, with a random port, the same exposure as `ssh -L`. A process on that machine that connects to it reaches that host's Chrome, which is no more than the transport itself already allows it. A listener on a loopback address never leaves the machine.

### Telling `cardd` about it

`cardd serve` takes `--browser`, a JSON object with one entry for each host that has a browser. The keys are host names, the same names that `--hosts`, `--clone`, `dispatch`, and `host` in `config/lane.json` use:

```sh
--browser '{
  "p620": {"cdp": "http://127.0.0.1:9222", "logins": {"tokenFile": "~/.config/bws/browser-logins.token", "project": "<p620 Logins project id>"}},
  "maverick": {"cdp": "http://127.0.0.1:9222", "logins": {"tokenFile": "~/.config/bws/browser-logins.token", "project": "<maverick Logins project id>"}},
  "cx-devvm-01": {"cdp": "http://127.0.0.1:9222", "logins": {"tokenFile": "~/.config/bws/cnp-logins.token", "project": "<CNP Logins project id>"}}
}'
```

- `cdp` is the address of that host's Chrome as the host itself sees it, an `http` or `ws` URL, `http://127.0.0.1:9222`. It is required. It is not an address that `cardd` connects to from outside.
- How `cardd` reaches a host: a host that `--hosts` lists is reached through its transport. For the CNP VM that is its IAP SSH command, such as `["gcloud", "compute", "ssh", "cx-devvm-01", "--tunnel-through-iap", "--command"]`, in `--hosts` and in `hosts` of `config/lane.json`. The host that runs `cardd` (not listed, and named like the machine, or `local`) is reached directly. Any other host in `--browser` fails at its first use with `the browser on <host> cannot be reached` and says to add it to `--hosts`.
- `logins` is optional for each host. Without it, `login` on that host says it is not set up. `tokenFile` is a path on that host, where `~/` is that host's home, and `project` is the id of the Logins project that host reads. Both are read there: see Secrets of each host.
- `logins.totp` is `false` by default and stays `false`. The captain has not approved one-time codes. With `true`, `login` on that host also fills a one-time-code field from the entry's `totp` seed. A generated code lives only in the memory of the `cardd` process, so after a `cardd` restart it cannot be hidden again. While `logins.totp` is `true`, a tab that was already open when `cardd` restarted refuses `read`, `eval`, and `screenshot` and says to call `open` again. The refusal ends only when `open` has replaced the page: an address that only changes the part after `#`, or a response that carries no page, leaves the tab refused and says so. Open a different page to end it, as the page then holds no typed code.
- Without `--browser`, `browser-axi` says that this fleet has no shared browser and exits 4, and no viewer opens anywhere. A `--browser` of the earlier form, one object with `cdp` at its top level, makes `cardd` refuse to start and print the form above.

`--browser` is part of `cardd`'s command line, so a change needs the captain to edit the launchd job as in section 2 and restart `cardd`.

When `--browser` is switched from the earlier single-browser form to this per-host map, restart each host's Chrome service once at the cutover: migration 026 already retired the old tab rows, and a restart drops the old tabs that `cardd` no longer tracks.

### Bitwarden logins

The fleet fills passwords itself, so nobody pastes one into a chat. The captain creates this once for each host that should fill logins, in Bitwarden Secrets Manager:

1. A project named `Logins`. Its id goes into that host's `logins.project`.
2. A machine account, such as `fleet-browser`, with read access to the `Logins` project and to nothing else.
3. An access token for that machine account. It lives on that host only, in `~/.config/bws/browser-logins.token` (the CNP VM: `~/.config/bws/cnp-logins.token`), owner the host's fleet account, mode `0600`, the same layout as the other tokens in `~/.config/bws/`. It is never in `cardd`'s command line, the database, or a chat.
4. One secret in the `Logins` project for each site. The key is the site's host name, such as `github.com`. The value is JSON: `{"username": "...", "password": "..."}`. An optional `"totp"` seed is read only when `logins.totp` is true. Keep each of the three fields text. `cardd` hides every one of them from workers, also when its sibling is empty. A value that starts with `{` and is not a JSON object with those fields as text or empty (a truncated edit, for example) is malformed: `cardd` hides its whole text, refuses the browser with a note that names the entry's key until it is fixed, and checks again on the next action. A key covers its subdomains: `github.com` covers `gist.github.com`, and the longest key that covers the page wins.
5. `bws` on that host's `PATH`.

How `login` works: the worker is on a site's login page and runs `browser-axi login`. `cardd` runs `bws secret list <project> --output json` on the host of the card's browser (through that host's transport when `--hosts` lists it), with the token read from the token file there and passed to `bws` only as `BWS_ACCESS_TOKEN`, never on a command line. It reads the answer in its own memory, picks the entry whose key covers the page's host, and types the username and password into the page's fields with CDP input. The page must be on the entry's site: `login` refuses any other page. It also types only into the page it checked: each value is entered by a call on the field that was found in that page, so if the page navigates or reloads while the vault is being read, or between two fields, a page that replaced it cannot receive the value, and `login` stops and types nothing more. After each value it compares the field's value with what it typed: if a script on the page rewrote it, or an old value stayed, `login` empties that field and fails with a note that the page did not keep it, rather than reporting `filled`. The values are never logged, stored, or written. The worker's result says only `filled`, `not found`, or why it failed.

`cardd` keeps a value out of what the tool returns, in the forms below, and it refuses `eval` on a tab while a field that `login` filled still holds a value (see the last two items):

- `cardd` keeps one set of hidden values for each host: every username, password, and one-time-code seed of every entry in that host's Logins project, whichever card or tab of that host asks. The set lives in memory only. It is read from the project before the first browser action of a card on that host, and again whenever `login` reads the project, and whenever `open` goes to a site that no `open` has gone to since the last read in the past minute. So a tab that another card logged in on, or a new entry that the captain just added, is hidden before its page can be seen. `login` reads the project before the first keystroke, so a login that fails halfway leaves its values hidden too.
- If the Logins project cannot be read when the set is needed, the action is refused and the note says why, and nothing is opened or returned. A fleet without a Logins project has nothing to hide and nothing to refuse.
- Every text that comes back from the tab (`read`, `eval`, `open`, `login`, and error messages) has each value replaced with `[hidden]`, as it is written, JSON-escaped, URL-escaped, form-escaped, or written in HTML (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, and numeric references), in text and in attributes. `eval` is cleaned before it is serialized, and a string that holds serialized JSON is read as JSON and cleaned inside, however deep it is nested. So `eval` of a password with quotes and backslashes shows `[hidden]`, also when the page ran `JSON.stringify` on it, and `read` with `html` shows `[hidden]` for a password with an `&`. Each text is also checked as the page would show it, before any value is replaced: `cardd` decodes character references (numeric ones of any length, such as `&#000000169;`, and every named one of the HTML Standard, such as `&amp;`, `&commat;`, and `&copy;`), once with the tags and comments removed and once with the tags kept, so a reference in an attribute value is decoded too, and looks for a value again. A value that only shows up that way, such as a username that the page splits over `captain.<strong>login</strong>@example.test`, a password that a page source writes as `S3cret&copy;2026` in text or in an attribute (`<input value="S3cret&copy;2026">`), or a username `李` that the page writes as `&#26446;`, makes the whole output fail with "this output contains a stored credential; read it as text, which hides it". The same holds when the value is split around a tag that is named like another stored value, such as `hun<mark>ter</mark>2` when `mark` is also stored. Nothing of the output is returned and the note names no value. This holds for `read` with `html`, for `eval` of `outerHTML` or `innerHTML`, for every string inside an `eval` result, and for a string that holds serialized JSON. `read` as text still works, because it returns what the page shows and shows the value in one piece. The check cannot see a value that the page splits around text that it hides, such as `captain.<span hidden>x</span>login`, in HTML: read the text instead, which leaves the hidden element out.
- A screenshot is refused when the page shows a stored credential, and is taken as it is otherwise. Before every capture `cardd` scans the tab and every iframe (also one from another site) in the browser's own tree of the page, which includes open and closed shadow roots. It collects what the page shows: its text as it is laid out (text that has no box on the page, such as `display: none`, `hidden`, `visibility: hidden`, or `content-visibility: hidden`, or whose boxes have no area after a transform, such as `transform: rotate(45deg) scaleX(0)`, is left out, and text of shadow content and of `::before` and `::after` content, also `content: attr(...)`, is put where it is drawn, so a value that the page splits across inline text, a shadow host, or generated content is one string), the browser's `innerText` of the page and the text of each shadow root, every attribute of every element (such as an option's `label`), and the value of every field, a password field that the page shows as dots included, which is how a login form that `login` filled is found. Each of them is checked with the same matcher as the text that goes back to a worker: a value raw, JSON-escaped, URL-escaped, or written with character references, in any letter case, and again after the references are decoded, with the tags removed and with the tags kept, so a username that the page writes out literally as `&#99;&commat;...` is found. If a value is found, no picture is returned and the note says: "this page shows a stored credential; read it as text, which hides it, or move past the login form". The note names no value. A page that is refused is not changed. If an iframe or another part of the page cannot be scanned, no picture is returned and the note says that the page could not be scanned. A page is refused more often than strictly needed, for example when a value only seems to span two blocks, and that is on purpose. The scan and the capture are one call, one after the other, and the scan does not claim anything about what the page does in between. Outside the guarantee is what no scan of the page's tree can see: text drawn into a canvas, an image, a video, or an SVG used as an image.
- `eval` is refused while a login-filled field holds a value. When `login` is about to type into a tab, `cardd` marks the tab and remembers each field that it typed into, as the element itself and not as a search for a stored value. The mark means that one of those fields in this tab's document may still hold the credential. It lives only in the memory of the `cardd` process: never in the database, a file, or a log. While the mark is on, `eval` on that tab fails with "a stored credential is in this page's form; click Sign in first, or read the page as text", and the note names no value. `read` keeps working and hides each value as above. `click`, `type`, `press`, `back`, `forward`, `reload`, `login`, `open`, and `close` are not affected, and `screenshot` is refused by the same check, with the note of a screenshot that shows a credential, before it is scanned as above. The viewer's copy of the selection (`browser.copy`, see The viewer) is refused by the same check too, with its own note. The mark ends when every remembered field is empty or has left the page's document: before it refuses, `cardd` asks the page, in a call bound to each field, whether the field is still in the document and not empty, and if none is, it ends the mark and runs the `eval`. A field that is not empty keeps the mark whatever it holds, so deleting one character, or showing the password as text, does not end it. A call that fails keeps the mark and refuses. When the page moves to a new document, as when the form is submitted and the site loads another page, or `open` replaces the page (`cardd` compares the id of the page's document with the one at the time of the fill, so an `open` that only changes the part after `#` stays on the same document), the remembered fields are of no use, and the tab keeps the fact that it was filled, because the browser can bring the form back: `history.back()` restores the old page with its username filled. So on a document that the browser did not open by a fresh navigation (history navigation or a reload, by the page's own navigation type), `eval` and `screenshot` are refused by the check that a tab gets after a `cardd` restart. A document that a fresh navigation opened (`open`, a link, or a submit) is not checked, so text that the worker types into a later page's own field, such as a search box, does not refuse them. A tab that was already open when `cardd` restarted has no mark and no remembered fields, as neither is kept, so they are refused while an input of the page holds a hidden value that `cardd` has read again, or while a password field, or the username field that `login` would have filled, is not empty. A password field that the page switched to text and the worker then edited is not found that way. An `eval` on a tab that `cardd` opened itself and never filled runs as usual.
- What is still outside the guarantee: the mark covers a login-filled field that is still in the page. It does not cover a page that keeps the credential in script-reachable state after the form is submitted (a variable, storage, or a field of a later page that the site fills itself), and `eval` of such a page can return a changed copy of it, such as reversed or base64, because `cardd` replaces a value only where it shows up in the forms above. A worker that injects its own script into the page before `login`, such as one that records what a field receives, can also keep a copy that the mark does not see. The hiding of pictures is a scan of text, so the credential can still reach a worker by canvas, images, video, and SVG used as an image, which the scan does not read. The hiding stops a value from reaching a worker by accident, through a page that shows it, a tool that echoes it, or an error. `login` is for workers that the captain trusts with the site. For a site where the worker must not be able to get the password at all, leave its entry out of the Logins project and let the captain sign in himself in the viewer, as for a passkey: the session stays in the profile and the worker never holds the password.

`bws` cannot list one secret by key, so all secrets of the `Logins` project pass through `cardd`'s memory during a lookup. That is why the project is only for logins and the machine account sees nothing else.

#### Secrets of each host

Each host reads its own logins, and nothing moves one host's secrets to another:

- A host's token file and `bws` are on that host. `cardd` runs `bws` there, through that host's transport, and the token is read there and goes to `bws` only as `BWS_ACCESS_TOKEN` on that host. `cardd` never reads a token file itself and never sends a token to another host.
- A host reads only its own Logins project. `login` on a card of host A reads A's project, fills only A's Chrome, and cannot find an entry that only B's project has: it says `not found`. The hidden values are the same: `cardd` keeps one set for each host, loaded only when a card of that host acts, so a call on host B never reads A's project, and A's values are not hidden from, or typed into, anything on B.
- The CNP VM (`cx-devvm-01`) gets the CNP identity only: a machine account of the CNP Bitwarden organisation with read access to the CNP Logins project, and its token file only on that VM. The personal Bitwarden token (`~/.config/bws/browser-logins.token` on p620 and maverick) is never on the VM, and the VM's token is never on p620 or maverick. Dotfiles writes each host's token file from that host's own source: no copying between hosts.
- A host with no `logins` has none: `login` says it is not set up, and nothing is read for it.
- What this does not do: `cardd` is the broker, so its process holds the values of every host whose cards act, in memory, and `cardd`'s host receives them over each host's transport. A host's credential is in `cardd`'s memory only while cards of that host use it, and never in the database, a log, or another host's Chrome. If the CNP identity must never reach the captain's host at all, leave `logins` out of its entry and let the captain sign in himself in the viewer, as for a passkey.

When the project has no entry for the site, `login` says `not found`, exits 3, and files a note on the card for its mate: `c-N needs a Bitwarden login for <site>`. The mate asks the captain once. He adds the secret in Bitwarden, and the worker runs `login` again. A repeated `login` on the same host does not ask again. The request belongs to the host whose Logins project lacks the entry: a card that moves to another host asks again there, and the note names that host's project.

Sites that need a passkey, a one-time code, or terms accepted are handled in the viewer in main's workspace (`--captain`, above): the captain clicks and types in the live tab once, and the session cookie stays in the profile.

### The viewer

The viewer is `packages/extension/src/browser-view.ts`. A herdr tab named `Browser` runs it. It starts a small page, prints its address, and, for the captain's workspace, opens it once. A viewer, captain's or gated, asks Sheprd to open it in a tab when its host shim is installed, and opens the host's default browser if the shim is absent or fails. The printed address remains available either way. A gated viewer's page is on `127.0.0.1`. The captain's viewer is on the host's tailnet address, or on `127.0.0.1` when the host has none (The captain's viewer on the tailnet). The page lists the live tabs it may show, each with the host whose Chrome holds it, shows the selected tab as a live picture, and forwards the mouse, the keyboard, pasted text, and composed text to it (see Input in the viewer, below), so the captain can do a passkey, a code, or a terms page himself. The viewer gets its credentials the same way as the program that placed it: a mate's or main's viewer is started with `--home <lane home>` and resolves the lane token itself, and a worker's viewer reads a one-use file (mode `0600`, deleted when it is read) that holds the card's address and token, so no token is in the pane's command line. A gated viewer gets its picture from `cardd` (`browser.frame`), and the captain's viewer from Chrome's screencast. Both talk to Chrome directly for input, and the gated one also for the size of the page, which it needs to turn a click on the picture into a point of the page. Each does that for a tab on the viewer's own host on that host's loopback, and for a tab on another host through that host's transport (see Where the viewer opens). Both ask `cardd` with that token which tabs exist: `browser.view` returns who owns each tab, whether it is live, and its title and address, which `cardd` reads from Chrome's target list and cleans of every stored value (a value is replaced with `[hidden]`, and a title that only shows one composed is hidden whole); a worker's viewer is told only about that worker's card, a mate's about its lane, and main's about every card. If Chrome cannot be reached, a tab is not live and has no title and address. `browser.view` gives each host 3 seconds: a host that has not answered by then (its transport is slow or hung, and the connection goes on in the background) is named in `problem` as unavailable, and the other hosts are listed as usual. While `cardd` has no read of the Logins project (it just started and no action has read it yet, a `login` is reading it again, or a read failed), titles and addresses are empty for every viewer but the captain's, because `browser.view` never waits for the vault: the next picture or browser action reads it, and the next poll shows the titles. It answers only for its own address, and only to a request that carries its token: each run makes a random token, prints the address as `http://<host>:<port>/?t=<token>` (`<host>` is `127.0.0.1`, or for the captain's viewer the host's MagicDNS name, or its tailnet address when it has no name), trades it for an `HttpOnly`, `SameSite=Strict` cookie on the first page request, which a small page answers that sets the cookie and then opens `/` itself, so a link that a chat app opens from another site works too (named `fleet_viewer_<port>` after the viewer's own port, because a browser shares cookies between the ports of one host and two viewers would otherwise overwrite each other's), and refuses every route without the token or the cookie. Set `FLEET_BROWSER_VIEW_OPEN=0` to stop it opening a page. A herdr pane that shows the picture itself is not used: see `docs/code.md`.

The viewer's states. With no live tab the page shows one message and nothing else in the stage: `No tabs open. Each card gets its own tab when its worker opens a page.` The address field is empty, the Back, Forward, and Reload buttons and the field are disabled, and there is no `live` badge and no hint. With live tabs and none picked, it says `Pick a tab on the left.` The badge and the hint appear when a tab is picked.

A worker's own `Browser` tab does not outlive its tab. `browser-axi close` closes the card's tab, then asks `browser.view`, and when the caller has no tab left it closes the `Browser` tab of its own workspace (`removeViewer` in `browser-place.ts`). It only closes a tab whose pane printed `(gated)`, so it never closes the captain's viewer, and a mate or main whose viewer still lists other cards keeps it. When a card ends (`close`, or the replacement of its worker), the worker's workspace is closed with the viewer tab in it. A worker run that is stopped (Escape in the pane) closes the card's tabs in Chrome and leaves its workspace, so its viewer stays and shows the empty message.

The picture of a gated viewer. The viewer polls `browser.frame` for the selected tab: one request in flight for each tab, the next as soon as the last has answered, with a floor of 150 ms between requests. So the picture is a polled one, a few frames a second, and not a smooth stream. `cardd` takes the call after the card's other calls (one at a time for a card), waits until the Logins project can be read, and then, in one call and in this order, refuses while a login-filled field still holds a value (the mark above), scans the page and its iframes for a stored credential, and takes a JPEG: the same code as `screenshot`. It refuses a tab that may show a one-time code after a restart too. A hit, a page that cannot be scanned, a Logins project that cannot be read, and any error answer with no picture and a note, which names no value. A picture is never taken before its scan, so a frame from before a login or a navigation cannot be approved by a scan of the page after it. A failed call hides the picture too. When there is no picture, the page gets the note and no image data, and it draws pictures again as soon as one arrives, in the same viewer. A picture that is the same as the last one sent to that page (the same size and the same bytes) is not sent again, so a page that does not change costs one picture and not about five a second. A picture that differs is eligible for delivery, subject to [acknowledgement pacing](#the-viewer-on-a-phone). A refusal is sent every time, and the picture after it is sent even when it is the same as the one before the refusal. Mouse, keys, paste, and composed text into a gated viewer still go to the tab. Copy does not go to the tab directly: it is a call to `cardd` (`browser.copy`), described next.

Input in the viewer. The page sends what the captain does to the tab as a queued `POST /api/input`, and the viewer turns each message into CDP `Input` calls (`browser-input.ts`). Messages go in order, so a key never overtakes a click, and a copy is one of the messages: it reads the selection after the input before it and before the input after it.

- Mouse: move (hover), press and release as separate events (so a drag selects text), the left, middle, and right buttons (a gated viewer drops the middle button, see below), while the back and forward buttons go back and forward in the tab like the toolbar's, are not sent to the page, and are kept from the browser that shows the viewer, which would otherwise move the viewer page itself back (the page cancels their `mousedown`, `mouseup`, and `auxclick`), the click count (a double click selects a word, a triple click a paragraph, and the page sees `dblclick`), and the modifiers. The point is the pointer's place in the picture, scaled to the size of the page. When the pointer leaves the picture, one move lands outside the page, so its hover ends. A move that has not been sent yet is replaced by a newer one, and wheel steps that wait together are added up. On a Mac, Ctrl+click is a right click. Dragging selected text or an image to another place is not supported: the viewer sends mouse events only and no drag events, so whether a drop happens is left to Chrome.
- Keyboard: a picture cannot take focus for text, so the stage holds a hidden text box. Clicking the picture, or a tab in the list, focuses it. Each key goes to the tab as `Input.dispatchKeyEvent` with its `key`, `code`, key code, location, repeat flag, and modifiers, and a key that makes a character sends that character as its text. A key with Cmd held, or with Ctrl held and Alt not, sends no text. The browser that holds the tab may not be a Mac, and Chrome acts on Mac editing keys only with an editing command, so a viewer on a Mac adds the command for Cmd+A, Cmd+Z, Cmd+Shift+Z, Cmd+Left, Right, Up, and Down, Option+Left, Right, Backspace, and Delete, Cmd+Backspace, and the Shift forms of the moves. Elsewhere Ctrl+A, Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z carry theirs. The list is `EDITING_COMMANDS` in `browser-input.ts`, and the viewer refuses any command that is not on it. A Mac's Option key that makes a character (Option+A gives `å`) sends the character without Alt. A Mac sends no key up for a key pressed with Cmd held, so the viewer sends one at once. The page remembers each key that it sent down, with the tab it went to, and sends that key's release to that tab when the text box loses focus or another tab is picked, last pressed first, with the modifiers of the keys that are still held and no repeat flag, so a key held while the captain moves on is not left down. A key up that the page did not send down is not sent.
- Composed text (IME): while a composition is open, and for key events with key code 229 or the key `Dead`, `Process`, or `Unidentified`, no key is sent. When the composition ends, its text is sent once, as `Input.insertText`. The composition itself is drawn by the browser at the hidden text box, which sits at the last place the captain clicked, and not inside the tab.
- Paste: Cmd+V or Ctrl+V sends no key. The page's `paste` event brings the clipboard's text, and the viewer sends it as `Input.insertText`. Only plain text is pasted.
- Copy: Cmd+C and Ctrl+C send no key either. Cmd+X and Ctrl+X do nothing: they send no key, and nothing is copied or removed. The viewer also drops any key message that Chrome takes for copy, cut, or paste (C, X, V, or Insert with Ctrl or Cmd held without Alt, and Shift+Insert and Shift+Delete), whether it names the key by `key`, by `code`, or by key code, and whichever page sent it, and the editing commands that it accepts do not include copy, cut, or paste. So a key sent through the viewer cannot make the tab's Chrome write its own clipboard, where a process on the host could read it. A Mac's Ctrl+C is dropped too. The page asks the viewer for the selection of the tab (`POST /api/copy`) and writes the answer to the captain's clipboard with `navigator.clipboard`, as a promise inside the key press, so the browser counts it as the captain's own action. The selection is what `getSelection().toString()` gives in the focused frame of the tab, also when that frame is an iframe from another origin, except that a selected part of a password field gives nothing. Text that is selected in a page around the focused frame is never used in its place: a frame with nothing selected gives `nothing is selected`. A selection of more than a million characters is refused. The page tells the captain what happened beside the picture's state: `copied 12 characters`, `nothing is selected`, or the reason. Only an address on `localhost` or `127.0.0.1` gives the page a clipboard, so a viewer opened through any other name cannot copy.
- Left to the browser that shows the viewer, never sent to the tab, and not stopped from reaching the browser: page zoom (Cmd or Ctrl with `+`, `=`, `-`, or `0`), developer tools (F12, Cmd+Option+I, J, or C, and Ctrl+Shift+I, J, or C), full screen (F11, and Ctrl+Cmd+F on a Mac), and tab and window commands (Cmd or Ctrl with T, W, N, Q, or a digit, Ctrl+Tab, Ctrl+PageUp, Ctrl+PageDown, and Cmd+H and Cmd+M on a Mac). These are keys that a browser reserves, or that the captain needs on the viewer's own page. Every other key goes to the tab, Tab and Escape included, so the viewer's own page cannot be moved with Tab until the captain clicks outside the picture.

Navigation in the viewer. The header has Back, Forward, Reload, and an address field, and they act on the worker's tab, in its one history, not on the viewer page: your own browser's Back and Reload still act on the viewer page. Each button says so in its name (`Back in this tab`, `Forward in this tab`, `Reload this tab`) and the line under the picture says it again. The viewer sends them to `cardd` as the `browser` op with the action `back`, `forward`, `reload`, or `open` for the tab's card (`POST /api/nav` in `browser-view.ts`), for the captain's viewer and for a gated one alike, so they run in the card's turn, after a worker call that is still loading and before the next one, the same as the worker's own `browser-axi back`. They are queued with the input in the page (`ordered`), so a key or click that was sent first reaches the tab first, and they are disabled while one is in flight. `browser.view` says for each tab whether `canBack` and `canForward` (from `Page.getNavigationHistory`, never offering the blank page that Chrome makes the tab with), and the page greys the button that has nothing to go to. The page and the worker share one history: a page that the worker opened, a link that the captain clicked, and a page that the worker opened again are three entries of the one list, and Back walks them in that order. Reload loads the tab's page again; it does not reload the viewer.

The address field shows the tab's address while it is not being edited, and keeps what the captain typed until he presses Enter or Escape (Escape puts the tab's address back). Enter loads the address in the same tab through `open`, so the Logins project is read again and the tab becomes trusted by the same rules as for a worker. An address without a scheme gets `https://` (`addressTyped` in `@fleet/protocol`; `host:port` counts as having none), and `checkedUrl`, the one function that `open` also uses, refuses everything but http and https, so `javascript:`, `file:`, and `chrome:` addresses are refused with `only http and https pages can be opened, not <scheme>` and the tab is not touched. A message goes in a line under the header (`navnote`) for eight seconds, also on a phone. A page that fails to load (a bare host that has no https) leaves the tab on Chrome's error page, with Back to return.

Keys, when the picture has focus: Alt+Left and Alt+Right (Cmd+[ and Cmd+] on a Mac) go back and forward, Ctrl+R or Cmd+R and F5 reload the tab (so they no longer reload the viewer page; click outside the picture or use the browser's own button for that), and Ctrl+L or Cmd+L focuses the address field. A host that reserves a key for itself (some app shells take Cmd+R) never delivers it, so the button is the dependable path.

The secrecy of a password that the captain types. A viewer, captain's or gated, tells `cardd` before every permitted input request to a tab, once for each tab that the request names, whether it carries mouse movement, clicks, scrolling, keys, or text (`browser.entered`, including after a `cardd` restart). The call waits for the answer, with the same timeout as viewer navigation so a slow worker load can finish first. A viewer that cannot establish provenance sends no input for that request. A viewer also sends the build id that it printed (`Viewer build:`, above) with every `browser.view`, which is its first request and the one that lists the tabs it can drive. A viewer from before `browser.entered` never declares what a person types, and `cardd` cannot tell it from a current viewer except by that id: when the id is missing, or is not the build of the code that `cardd` runs from, `cardd` marks every tab in that answer as entered before it answers, so the refusals above apply to those tabs as soon as a password field is not empty, and stop when it is submitted or cleared. Such a viewer cannot say when a login form appears or is revealed, and the page's own tracking cannot watch every scope from the moment it is created, so in these tabs every field that can hold text and that is in a shadow root or in a frame of another process counts as a password field, even one that was revealed before it was typed in. The text fields of the page's own document keep their exact identities. A tab that is listed to a viewer of another build is marked for good, until the tab closes. `browser-axi` sends its own build id with the `browser.view` calls it makes, so it marks nothing when it is current. Failed input requests show an `Input failed:` alert instead of disappearing silently. `cardd` then refuses `eval`, a screenshot, a picture for a gated viewer, a copy, and `read --html` for that tab while any password field of the page is not empty (`holdsPassword` in `browser-scan.ts`: an `input` that has had type `password` or password autocomplete, including cross-origin frames and shadow roots; a reveal toggle does not erase its identity), with the note `<what was refused>: a password entered through the viewer is still in this page's form; wait until it is submitted or cleared, or read the page as text`. Text `read` is not refused: the page's text does not hold a field's value. The refusal ends by itself when the field is empty, as after the form is submitted and the page moves on. A worker that types a password itself with `type`, in a tab that no viewer has interacted with, is not affected, since it knows what it typed. The mark is in `cardd`'s memory (`HostBrowser.entered`, dropped with the tab). On startup every surviving tab is conservatively marked as entered and as assumed, as a tab listed to a viewer of another build is, because a viewer that kept its tab through the restart may not declare what is typed. Its existing text-entry fields are treated as possible password fields because a reveal toggle may have removed their original type. Opening another page does not remove the tab's mark or the old field identities, so returning through history stays protected. Before input is sent, CDP initializes field tracking in isolated worlds that page scripts and worker eval cannot modify. The browser remembers password field identities without keeping their values. An inspection failure conservatively refuses reads, and a gated viewer's picture is hidden by the same refusal, so the captain who types a password into a gated viewer sees `Hidden:` and the note until the page moves on, and the captain's viewer, which reads Chrome directly, keeps its picture.

The secrecy of copy. A gated viewer does not read the selection from Chrome. It calls `browser.copy` on `cardd`, which takes the call in the card's turn like `browser.frame`. `cardd` waits until the Logins project can be read, attaches the card's own tab (a different target is an error), refuses a tab that may show a one-time code after a restart, and refuses while a login-filled field still holds a value (the mark that `eval` and a picture use), with the note `nothing was copied: a stored credential is in this page's form; click Sign in first, or read the page as text`. Otherwise it reads the selection and cleans it as `read` cleans text: a stored value becomes `[hidden]`, and a text that only shows one composed is refused. Any failure answers no text and a note that names no value, and the page writes nothing, so the clipboard keeps what it had. The captain's viewer is not gated: it reads the selection from Chrome the way it takes the picture from Chrome. A gated viewer also drops the middle button, and only the captain's viewer sends it. On a Linux host, Chrome writes any selection to its primary selection and pastes that on a middle click, so a login-filled value that was selected through the viewer could land in a page that the worker controls, which would bypass the refusal above. Nothing else in the input reads the page.

What this does not cover:

- A password that the captain typed shows in the tab's text if the page itself writes it there (a "preview" that copies the field into a paragraph), and a field that has never been a password input is not looked at. Frames of every origin and shadow roots are included. `cardd` cannot hide a value that it was never given.
- The scan and the capture are two steps in one call, the same as for a screenshot: the page can change between them.
- A process that talks to Chrome's CDP port directly is outside the guarantee, the viewer included. The gate is in `cardd`, not in Chrome.
- The captain's viewer in main's workspace is not gated, and main's agent can read that pane (its address and token, and the page it serves). Its link works from any machine that the tailnet lets reach main's host.

### The captain's viewer on the tailnet

The captain works from another machine than main's host, so a loopback address in main's `Browser` tab reaches nothing for him. The captain's viewer (`--captain`, started in main's workspace for a summon) therefore listens on its host's tailnet address and prints a link that he can open from any machine on the tailnet:

- It asks the host's own Tailscale: `tailscale status --json` (`FLEET_TAILSCALE` names another command, and on macOS the app's own `Tailscale` command is tried when `tailscale` is not on the `PATH`). It needs `BackendState` `Running` and takes the first IPv4 address of `Self.TailscaleIPs`, never `0.0.0.0`. It binds that one address and no other: not `0.0.0.0`, not `::`, not a LAN or a public interface, and not loopback, so a request to `127.0.0.1` on that port is refused by the operating system.
- It prints `Fleet browser viewer (captain): http://<name>:<port>/?t=<token>`, where `<name>` is `Self.DNSName` (the MagicDNS name, lower case, with no trailing dot), or the tailnet address when Tailscale has no name for the host. A second line says that it listens on the tailnet address only.
- It answers only a request whose Host is its own tailnet address or MagicDNS name with its port, and whose Origin, when there is one, is the same. A page of another site cannot reach it by rebinding a name to the address, because that name is not allowed. A viewer that fell back to loopback (below) accepts `127.0.0.1:<port>` and `localhost:<port>` for any port, because an SSH forward listens on a port that need not be the viewer's, with the same Origin rule.
- Authentication works as described in [The viewer](#the-viewer), including links opened from chat apps. A request without the token or cookie is a 403, from any address.
- When Tailscale is not installed or not running, when it answers nothing usable, or when the bind fails, the viewer falls back to `127.0.0.1` and says so in the tab: `No tailnet address was found (<why>), so this viewer listens on this machine only. Open the link here: another machine cannot reach it.` The captain then sees the page only on main's host, or through Sheprd's SSH forward of that loopback port (Sheprd on frontera).
- Gated viewers (a worker's, a second mate's, and main's own when the captain is not summoned) never ask Tailscale and stay on `127.0.0.1`.

### The link reaches the captain, and a stale viewer is replaced

A link that stays in a pane reaches nobody who works from a phone. So a summon that main answers carries the link to main:

- After main's extension has placed the captain's viewer, it reads the printed `Fleet browser viewer (captain): <address>` line from the `Browser` pane and adds the address to the note that it hands main's session, after the sentence that names the card and the reason. The note says that the link opens on his phone or his Mac over Tailscale, and that main sends it to the captain in a message of its own and writes it nowhere else.
- The address goes into that one message of main's own session and the pane. It is never written to `cardd`, the board, a card, a report, or a log, and a worker never sees it. If the viewer printed a loopback address (no tailnet address, above), the note says that his phone cannot open it, and names the fix, which is Tailscale on main's host.
- A viewer whose address is not in the pane after 15 seconds, or a placement that takes more than 45 seconds, does not hold the note back: main gets the note without a link and reads the address from the tab. A placement that fails gives main a note that names the error and says to start the viewer from the `Browser` tab.

A running viewer is no better than the code it started from. A viewer prints `Viewer build: <id>` after its address and any reach note: 12 hex digits of a SHA-256 over the TypeScript source of the extension and protocol packages of the checkout it runs from. Placement compares it with the build of the checkout now. A running captain's viewer with another build, or with none, because it started before this line existed, is stopped with Ctrl-C and started again, so an update reaches the captain on the next summon with no step by hand. A captain's placement replaces a running viewer of another build whatever it holds. A gated placement (a worker's, or a second mate's) replaces a running gated viewer of another build, or one that prints none, only when `browser.held` says that no tab the session sees still holds a password that a viewer entered (the field is not empty, as for the refusals in The viewer); a viewer that cannot be asked counts as held, so a sign-in in progress is not cut off and a failed question keeps the viewer. A gated placement never replaces a captain's viewer. The restart makes a new address and token, and the note that the summon carries holds them. Each start also gets a launch marker: the command ends with `--launch <id>` (16 hex digits, new for each start), and the viewer prints `Viewer launch: <id>` after its build line. The link that the summon carries is read only from the record whose launch line holds that id, so a viewer that was stopped and started again never hands over the dead link that its predecessor left in the pane. A viewer that is reused, because it is current, is read from its printed record. A viewer that a program from before this check placed is not replaced by that program, so the first update after it needs one step: restart main's Pi, and the next summon replaces the old viewer.

The threat model. The link is the only credential, and it moves the viewer's reach from this machine to every machine that the tailnet lets reach main's host on that port. The traffic is plain HTTP inside the tailnet's WireGuard tunnel, so it is encrypted on the way and has no certificate of its own. Anyone on the tailnet who has the link, or who guesses the 192-bit token (they cannot in practice), sees and drives the tab as the captain does, and the captain's viewer is not gated, so it shows a page with a filled login form as it is. So treat the link like a password: it is in the pane's text, the captain's browser history, and wherever he pastes it, and it changes every time the viewer starts. Use the tailnet's ACLs to limit which machines can reach main's host. The viewer ends with its tab. What it does not do: it adds no login, it does not check who on the tailnet is asking, and it does not stop a process on main's host that can read the pane (see What this does not cover). A tailnet that main's host is not on, or a host with no Tailscale, has no tailnet address, and then the viewer is on loopback only, as before.

What the viewer token does and does not stop. It stops accidental access and access from web pages: a worker's `curl localhost`, or a page script in the captain's browser. It does not stop a worker that runs on main's host as the same unix user and reads main's files, because it can read the token from the pane or the lane token from `config/lane.json`. The same holds for the Chrome itself: CDP on `127.0.0.1:9222` has no login, so any process that can reach it, which on its own host means any process of the same account and anything that can run a command through the host's transport, controls every tab of that host, and the per-card isolation of `browser-axi` holds for a worker that uses it, not for one that goes around it. Real isolation from such a worker needs a credential on the CDP port or a separate unix user for workers. That is a dotfiles decision and not part of this change.

### The viewer on a phone

The captain signs in from his phone as well as his Mac, so the viewer's page has a phone layout. It applies when the window is at most 640 px wide or the main pointer is a finger (`pointer: coarse`), and a wider screen with a mouse keeps the layout above.

- The tab list becomes a strip above the picture, and the picture fills the width. The tab itself is fitted to the phone: the page sends the size of its picture area and its pixel ratio (at most 2) to `POST /api/fit`, and the captain's viewer sets Chrome's device metrics override for that tab through its own session (`Emulation.setDeviceMetricsOverride`, width and height in CSS pixels, not mobile). So a sign-in page is laid out for 390 px and drawn once, not a 1280 px page shrunk to a third. The override is the viewer's, so it ends when the viewer stops watching the tab, when the page asks to clear it, or when the viewer's connection to Chrome closes. A fit is skipped when the tab is no longer watched. If watching ends while Chrome applies it, the override is cleared when Chrome answers, so a slow link cannot leave a tab at the phone's size with nobody watching it. A gated viewer answers `404` to it and never changes a tab. The page does not ask again for a tab that was answered `404` while that tab stays picked, and a `404` for a tab that has vanished does not stop it fitting the next tab. A worker that reads or clicks the tab while the captain watches on a phone sees the phone's viewport.
- Touch, with pointer events: a tap clicks, and a drag scrolls the tab (the finger moves the content, `touch-action: none` keeps the phone's own scroll and zoom off the picture). The browser's mouse events that follow a touch are dropped, so a tap does not click twice. There is no pinch, no long press, and no hover on a phone.
- The `Keyboard` button opens a bar with the keys a phone keyboard lacks (Esc, Tab, the four arrows, Backspace, Enter) and one text field. The field mirrors what the captain types into the focused field of the tab, key by key, so Backspace in it deletes in the tab, and a Gboard or iOS suggestion that replaces a word is sent as the difference. It starts empty again after Enter, after a key of the bar, after a tap on the picture, and when another tab is picked or none is. The field is a real input with `autocomplete="one-time-code"` and 16 px text, so iOS offers a code from Messages above its keyboard and does not zoom the page. The page follows the visual viewport, so the keyboard does not cover the bar.
- Typing and clicks go in one `POST` for everything that waited for one tab while the last one was in flight, not one `POST` for each key, so a phone on a slow link does not fall behind by a round trip for each key. The server applies the list in order and answers `204`, or `404` when it does not list a tab in it.
- The picture is paced: each picture waits for the page's acknowledgement of the last one (`POST /api/ack?id=<stream>&seq=<n>`, sent when the image has loaded), and the newest picture replaces any that waited meanwhile. Each picture a stream sends carries a number `seq`, and the number is never used twice by any stream of the viewer. Only the acknowledgement of the picture that is in flight releases the next one: a repeated acknowledgement, a late one, and one for a picture of an earlier stream with the same `id` do nothing. So a retry is safe. Nothing else releases a picture: not a timer, and not a drained socket. On a slow link the picture is late by a round trip and not by a queue. The viewer answers an acknowledgement `204` for a stream it has (whether or not it released anything), `404` for one it does not, and `400` when `seq` is not a number. The page gives each acknowledgement 3 seconds and tries it 3 times, with a short wait between. When the tries are used up, or the answer is `404`, the page closes its stream and opens a new one for the same tab with a new id, which shows the newest picture first. It does this at most once in 5 seconds, and only for a picture that is still the newest one on its stream: a newer picture proves that the acknowledgement had arrived. When the connection drops and the page's `EventSource` reconnects with the same id, a stream that names the id of a live stream ends the old one. Every connection that opens, a reconnection and a reset too, fits the tab to the phone again, because the viewer gave the window back when the old stream ended.
- What was and was not tested. The end-to-end tests drive Chromium with an iPhone 13 profile (viewport, pixel ratio, touch events). That is an emulation: it does not run iOS or Android, their keyboards, their autocorrect, or their handling of focus, so whether iOS Safari opens its keyboard from the `Keyboard` button, how Gboard sends Backspace and composition, and how a real finger scrolls are reasoned from the page and stay open until the captain tries it on his phone.

### Sheprd on frontera

[Sheprd](https://github.com/sheprd-labs/sheprd#install) is a native herdr client with browser tabs on macOS. Captain setup on frontera:

1. On macOS 14.2 or newer, run `brew install penso/tap/herdr-gpui`, then `open /Applications/Herdr.app`. The legacy cask and app path now install Sheprd.
2. Ensure frontera can run `ssh maverick` and `ssh p620` without an interactive authentication prompt. Sheprd needs herdr 0.9.0 or newer on each remote host. The minimum in Prerequisites is higher, so a host that passes the fleet check qualifies. Keep the existing daemons and sessions; do not migrate them to herdr-core.
3. In Sheprd, choose **Add Device…**, then **SSH host**. Add `maverick` and `p620` separately and connect to their existing herdr sessions.
4. Accept the browser skill installation offer, or use the command palette's **Install Browser Skill for Agents**. Leave `[agent_skill] install = "ask"` (the default), not `"local"` or `"off"`, so Sheprd installs the remote shim on connected saved hosts.
5. Select main's workspace. When fleet places the captain viewer, Sheprd opens its page in a browser tab. The link names the host's tailnet address (The captain's viewer on the tailnet), which frontera reaches over the tailnet, and Sheprd opens it as it is. Sheprd forwards only an address on the host's own loopback, so it forwards the page over SSH automatically only when the viewer fell back to loopback. If no tab opens, use the address printed in the `Browser` pane, with your own SSH local forward when it is a loopback address.

Fleet tries `~/.local/state/herdr/gpui/bin/sheprd browser open --tab <viewer URL>`. Current Sheprd source still installs the shim as `herdr-gpui` in that directory, so fleet also accepts that name. See [remote browser setup](https://github.com/sheprd-labs/sheprd/blob/main/crates/sheprd-gpui/README.md#letting-agents-open-pages).

The token URL rests for about 30 seconds in herdr workspace metadata and in Sheprd's saved tabs on frontera (`~/.local/state/herdr/gpui/browser-tabs.json`). Treat both as sensitive, like the printed viewer address. The token dies with its viewer run. A forwarded listener is loopback-only, and every route of the viewer still requires the token. Gated worker viewers keep their `browser.frame` pull model.

## 3. Lanes and projects

Run these once on the `cardd` host. `lane add` prints the mate's token. A lane's `--home` is informational.

```sh
$CARDD lane add main --db ~/.fleet/cards.db --home ~/Projects/fleet
$CARDD lane add cleo --db ~/.fleet/cards.db --home /path/on/its/host --parent main
$CARDD project add web --db ~/.fleet/cards.db --delivery no-mistakes \
  --clone maverick=/path/to/web --clone p620=/path/on/p620/web
$CARDD project clone web p620=/new/path/on/p620/web --db ~/.fleet/cards.db
$CARDD project unclone web maverick --db ~/.fleet/cards.db
$CARDD project remove web --db ~/.fleet/cards.db
$CARDD project yolo web on --db ~/.fleet/cards.db
$CARDD project repo web acme/web --db ~/.fleet/cards.db
$CARDD project delivery web direct-PR --db ~/.fleet/cards.db
$CARDD card delivery 125 direct-PR --db ~/.fleet/cards.db
```

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

- `host` is the name of the host this lane runs on, the same name that `--clone`, `dispatch`, and `--browser` use for it. A mate's browser is the one of this host, and its viewer reads the Chrome of any other host through `hosts` (The browser of each host). It defaults to this machine's hostname, first label, lower case. Set it when the hostname differs from the fleet's name for the host, such as `"host": "maverick"`.
- `hosts` names the hosts that main reaches over SSH. A host that is neither listed nor this lane's own host has no transport: the fleet never runs its commands here, and says `no transport for <host>`. `roots` is each remote host's checkout, and defaults to `~/.fleet/app`. A worker that the lane starts on a remote host loads the extension from that checkout (`<root>/packages/extension/src/index.ts`), not from the lane's own home, which the other host does not have. Set `roots` for each remote host where the checkout is not at `~/.fleet/app`. Without it, the fleet looks only in `~/.fleet/app` of that host, and a dispatch there refuses when the extension is not in it.
- `cardd` tells `/updatefleet` how to update `cardd` (section 7). `host` is the host that runs it, `local` by default or a name from `hosts`. `root` is the checkout it runs from, and `db` its database, both on that host, where `~` is that host's home. `restart` is the command that restarts its service on that host: for launchd, `launchctl kickstart -k gui/<uid>/<label>`, with the uid from `id -u`. Without `cardd`, the update leaves `cardd` alone and says when its code changed.
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
