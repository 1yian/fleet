# The code

Code in this repository has no comments. A lint rule fails on any comment. What a comment would say goes into a name, a type, or a smaller function. What a name cannot carry, such as why a module is shaped the way it is, lives here. [The spec](spec.md) owns the design. This file owns the reasons in the code that the spec does not name.

## Gates

- `eslint.config.js` holds the lint rules. Inline disable comments are off (`noInlineConfig`), so a rule changes only there, in review.
- `fleet/no-comments` is a local rule in `eslint.config.js`. It allows one comment that the toolchain reads: a triple-slash `<reference lib="..." />` directive, which `e2e/board/board.test.ts` needs for the DOM types of the code it runs in the browser.
- `.dependency-cruiser.cjs` holds the module boundaries. `cardd`, the extension, and the board share only the wire protocol. End-to-end tests drive real processes, so they import only the protocol.
- `packages/cardd/scripts/check-migrations.ts` applies every migration to an empty database, checks the result, and compares it with the committed `schema.sql`. With `MIGRATIONS_BASE` set to a git ref, it also fails when a migration that exists at that ref was changed, renamed, or removed. `--write` updates `schema.sql`.

## Protocol

`packages/protocol` is the wire protocol between `cardd`, the extension, and the board. Each schema is the one source of its type and its validator. `parse` throws one readable error that names the first problem.

## cardd

### Command line

```
cardd serve --db <file> [--listen <host:port>] [--board <built board folder>] [--hostname <name>]...
cardd lane add <name> --db <file> --home <path> [--parent <lane>]
cardd project add <name> --db <file> --delivery <mode> [--clone <host>=<path>]... [--yolo] [--repo <owner/name>]
cardd project clone <name> <host>=<path> --db <file>
cardd project yolo <name> on|off --db <file>
```

`project add` without `--repo` reads the project's GitHub repository from the `origin` remote of a clone on the `cardd` host. `serve` fills in any that are missing at each start.

`project clone` sets one host's clone of a registered project to a new path, so a clone can move. Attempts already begun keep their worktrees where they are: close finds them through the clone's worktree list, not through a stored path.

`lane add` prints the mate's token. `CARDD_TIMING_SCALE=0.01` speeds up every timer, for tests. `project yolo` sets the captain's standing merge authority for a project. Only the captain sets it, through this command line.

### Storage

- `store.ts` reads and writes `cards.db`. A mate's session ID is its lane name. Rows leave the database as JSON that SQLite builds, and are checked against the protocol schemas, so the types match the wire. A card from before names existed is known by its number.
- A session's token is the HMAC of its role and ID under the database's key. The same session always gets the same token, and no mate can share a token with a worker.
- `db.ts` applies every new migration in one transaction, so a failed migration leaves the database as it was. Foreign keys are off while migrations run, as SQLite's procedure for rebuilding a table requires: dropping a parent table counts each child row as a violation that its replacement never clears. Instead, every key is checked after each migration, and a violation names its rows. Every foreign key in the schema is one column.
- Raising a card's revision without a status change makes the board refuse answers to a hold that changed.

### Status and holds

- `status.ts` is pure. A card has a phase, where its work stands, and at most one hold. Its status is the phase seen through the hold. No operation sets a status.
- A hold that waits on the captain makes the card Needs you. A hold that waits on a mate makes it With mate. A hold with a future date is Waiting until then. A closed card has no hold.
- `change.ts` is the only way a status changes. It applies the transition rules and guards of spec sections 7.3 and 7.4. The entries a caller writes next count: the hold is read as it will stand once they are written.
- `holds.ts`: a card has at most one hold, with every question of its gate bundled in it. The card's own mate owns it. It waits on the mate, then main, then the captain, and climbs one level at a time. Only main marks a hold as the captain's. Main's own cards skip main. Holding the same hold again writes nothing. A hold after a release is the next occurrence of the same hold.
- Only the captain's exact words release what waits on the captain. Merge approval is such a release. Own words on a merge question request changes: only the Approve option approves.
- A steer withdraws the merge question while the PR is reworked, because approving a PR that is about to change would approve the wrong head. The worker's next `done` asks again, as the same hold.
- The captain's comment takes the hold back from him. The owner decides what it does.

### Talking

- `comments.ts`: a comment is the one way to talk to an agent. A worker's card hears its mate. A second mate's lane card, or any card in its lane, hears main when main speaks, and main hears the second mate when it answers. Main never steers another lane's worker. A comment cannot answer a worker's decision that waits on the captain.
- `ops.ts`: a report reaches the mate when its status hands off, or when it is the first report after a comment that reached the worker (spec section 10.3). Each operation runs in one transaction.
- `replies.ts`: a mate can ask for a reply to one comment, on its worker's card or, as main, on a card in a second mate's lane. The comment entry is the record: it carries `owes`, the recipient, and the reply's id is `r-<entry id>`, so the record exists in the same transaction as the comment, before any push. The open replies are derived from the card's entries, like its hold. Only an entry from the recipient that names the id in `replyTo` answers it: a worker's report, or the second mate's comment or hold, which goes to the asker. Only the asker withdraws it. The timed check resends it once to the recipient, then tells the asker once, as findings that name the id. Each step waits until the recipient has been quiet (idle, or gone) for the grace period of `timing.ts`, and the grace starts again after a hold on the card ends, so an agent waiting on its own decision is not poked. After the escalation the reply stays open until it is answered or withdrawn. Replies on a closed card are not nudged and not shown.
- `echo.ts`: when a parent commented on a card and the mate has not acted on it since, the mate's next action also reaches the parent. It is sent once, because the next action ends the wait.
- `authority.ts`: the mate's extension checks chat words against its own session file. For any other source, the words must be in a captain entry: a board comment, an option click, or an earlier answer. A project's yolo flag lets its mate have the worker merge a green PR without asking. A done PR in such a project goes straight to Merging.

### Attempts, delivery, and the server

- Delivery modes: a ship card records its mode in `cards.delivery`. `card.new` takes the project's registered mode, and maps `no-mistakes-prod-only` to `no-mistakes`, its most rigorous leg, as Firstmate's `fm-project-mode.sh` does for mechanical callers. `attempt.begin` records an override that the mate passes, and writes the card's mode into the task message as its `Delivery:` line, so the worker reads the mode from the card. A task that names another mode is refused. A worker that already runs keeps its mode: a new mode needs a new attempt.
- A local-only card has no PR. Its worker starts from the clone's local base branch, without a fetch, because local-only work lands there and never on origin. Its `done` carries where its branch lands instead of a PR lookup, and raises the same merge question about the branch. The timed check and close never look up a PR for it.
- `attempts.ts`: an attempt is one run of a card by one worker. Its ID is the retry key for dispatch. A dispatch retry on the same host finds the same attempt, with the same token and no second task message. A new attempt gets its task message in the same transaction, so a retry can neither lose it nor repeat it.
- `deliveries.ts`: every unconfirmed entry is pushed at a connect, otherwise only the pending ones. Each push carries its card's short name, which the message shows after the card number. No entry quotes the comment it answers, so when a second mate steers its worker right after main's comment, the worker gets the steer alone, never main's words to its mate.
- Delivery and intake are two facts. A delivery's state says where the entry is: pending, pushed, acknowledged, or confirmed in the session file. Its intake says whether the receiving model took it in: a run that held it in context ended with no abort and no error. A message can sit in the session file and still not be taken in, when the captain aborts the turn or the provider fails, and Pi drops a queued follow-up on Escape. The extension's `ack` therefore comes when that run settles, not when Pi adds the message, so a `cardd` that is older than the extension only records the acknowledgement later.
- The timed check chases a mate's delivery that is not taken in once the mate has been idle past the intake grace, as Firstmate's task inbox re-rings an unhandled record and then escalates it. It sends the same entry again once, marked `again`, which the extension injects even though the session file has it. One grace later it escalates once: to the lane's parent as a `missed` finding, or for main, as a note on the card, which the board shows. Then it stops. A worker's delivery is never chased: a worker the captain stopped stays stopped. This tracks whether a message was taken in, not whether anybody answered it.
- `server.ts`: one websocket per session, plus `POST /call` with a bearer token for scripts. The first message must be hello with the token. Every later message checks that the session is still live, so an ended or replaced attempt loses access at once. At start no session is connected: live sessions reconnect and become idle.
- `web.ts`: the board has no login, and only the Tailscale network reaches `cardd` (spec section 21.4). Every board request must name an allowed Host, which closes DNS rebinding, and its Origin, when present, must be allowed.

### The timed check

- `check.ts` is one level-triggered pass over `cards.db`. Each rule finds (card, condition) pairs. A finding is written once while its condition holds and clears when it stops. When everything is in order, the check wakes nobody.
- Workers never name their PR. `pulls.ts` finds a ship card's PR on GitHub by its attempts' branches, newest first, in the project's repository (`projects.repo`): `gh pr list --repo --head <branch> --state all`. It looks it up for a worker's done report, for each check pass, and before close, each time fresh. The URL found last is kept on the card only for the board and the merge question's text. A project with no repository on record is never looked up.
- PR state is read with `gh` before the check's transaction. A PR that could not be read keeps its PR findings open.
- A done report on a ship card carries what the lookup found, for the mate to read: the PR's URL and state, a note that no PR has the card's branch as its head, or why the lookup failed. A done with no PR still reaches the mate, which asks the worker to open one. A PR found already merged or closed raises no merge question.
- A finished card (done reported or PR merged, no hold) only needs closing, so its mate is reminded sooner, and the lane's parent hears when a second mate leaves it open. Only the mate closes it.
- Past the list of reminder times, one more fires for each repeat of the last gap.
- Before close, `cardd` finds the PR of a ship card whose merge is not on record yet, so a worker that just merged need not wait for the next pass. That finding is told to nobody, because the mate is closing the card.
- `github.ts`: `gh pr checks` exits non-zero while checks fail or pend, so its JSON decides. A failed read is an error, not an empty list. Only "no checks reported" is empty.
- `timing.ts` holds the timers of spec section 28. Three missed job heartbeats make a job lost.

### Closing

`closing.ts`: close decides Done or Dropped from the record (guard 7, spec section 20.5), the way Firstmate's teardown did. A local-only card lands only when its landing is authorized: the card is Merging, by yolo or by the captain's approval. Then `close.begin` asks the host to land it. Done means landed. A merged PR landed everything. Otherwise the worker must have reported done, a ship card must have no unmerged PR, and the host confirms that no attempt has a commit off the base branch or an uncommitted file. Dropped is never a fallback: the mate asks for it with `landed=false`, and a merged PR refuses it. A captain card has no worker, so it closes as Done once the captain acted. The record is checked again after the host confirms. When a second mate closes its own card, main hears. When main closes it, the card's mate hears.

## Extension

### Entry and arguments

- `index.ts`: dispatch starts each worker with `--fleet-url`, `--fleet-token`, and `--fleet-role`. `FLEET_URL`, `FLEET_TOKEN`, and `FLEET_ROLE` work too. A Pi in a lane home needs none of them: the home's `config/lane.json` makes it that lane's mate. Without either, the extension does nothing.
- `fleet-args.ts`: each value follows `=` in its flag, because Pi reads a separate value that begins with `-` as an option, and 1 `cardd` token in 64 begins with `-`. `launch.ts` turns `--token <value>` into `--token=<value>` for the same reason.
- `.pi/extensions/fleet.ts` loads the fleet extensions only in a lane home. A worker in a worktree of this repository has no `config/lane.json`, so it loads nothing from there and needs no installed packages. Dispatch gives workers the extension with `-e`.
- Activity at each run and tool call keeps `last_activity` fresh for the stall check (spec section 12.2).

### Sessions

- `link.ts` holds the session's one websocket. It sends hello with the fleet entry IDs found in the session file, reconnects with backoff, and matches calls with their results. A message from `cardd` that fails the protocol schema closes the socket, which reconnects with backoff, and the session says so once until it connects again. An exception in a websocket listener would end Pi, so a `cardd` on other code would crash-loop every mate.
- `intake.ts` acknowledges each fleet message that reached the model when its run settles, unless the run was aborted or its last answer failed. `link.ts` keeps an acknowledgement made while `cardd` is unreachable and sends it at the next connect.
- `inbox.ts`: Pi skips session file lines that do not parse, such as a line torn by a crash, and so does the extension. Pi creates the session file late, so it may not exist yet. A time from the model must be ISO 8601 with `Z` or an offset, so no host's zone can shift it.
- `worker.ts`: a run may end only with a handoff, a tracked wait, or a queued continuation. Otherwise the worker gets one nudge, then files `stopped`.
- `prompts.ts` adds the role contract to the system prompt of every run, so the contract follows the role wherever Pi starts.
- `views.ts` prints `board` in the AXI shape (https://axi.md): TOON records, few fields by default, counts first, long text cut with its size, an explicit empty state, and next steps. It is pure. The board's header is AXI ambient context: the projects with their yolo flag and, for main alone, the lanes. Past a set number of projects, it lists only those with open cards or yolo on. A mate reads the fleet through `board`, never with sqlite.

### Dispatch and herdr

- `dispatch.ts`: `cardd` creates or finds the attempt. Each host step then looks for its own result by the names that derive from the attempt ID, so a retry after a lost connection never starts a second worker.
- herdr counts an agent as ready when it idles, and a worker starts on its task at once, so herdr's own wait often runs out. Dispatch does not rely on it: the pane shows whether Pi started. herdr's minimum wait is just above 3 s.
- herdr refuses a start and types nothing when the shell is not at its prompt yet, or when it still holds the agent name of a worker that died a moment ago, for up to about 4 s on CI. A refused start goes again at once. A command lost before the shell goes once more. herdr refuses a pane where Pi runs, so no second Pi starts.
- A new shell first runs its prompt's helpers, such as git, and keys typed then can be lost. So a start waits until the shell is idle.
- Pi in the worker's pane is the truth about a worker, because `cardd` may not have seen it die yet. Pi names its process `pi`: macOS reports it as argv0, Linux as the process name.
- `host.ts`: a host listed in `FLEET_HOSTS` runs herdr through its transport, such as `["ssh", "p620"]`. ssh exits 255 for a lost or refused connection, which, like a probe that times out, means the host is unreachable. `--session` must come before a `--` delimiter, or herdr passes it to the agent. A herdr failure message never shows the command line or a worker token.
- The attempt's worktree is the one at `<clone>.worktrees/<session>`. The worker may switch to its own branch, so the path is the key.
- `place.ts`: as in Firstmate, a worker's workspace sits right under its mate's workspace, labeled with the card's name after `└ `. herdr does not nest plain workspaces, so order and label make the tree. The herdr CLI cannot move a workspace, so this uses herdr's socket API. A failed move only leaves the worker at the end of the sidebar.

### Jobs

- `jobs.ts`: `cardd` records a job first. The wrapper posts the result, which arrives as a fleet entry, also after a Pi restart. Nothing runs a job again. A running job is a tracked wait.
- `job.ts` is the wrapper. It reads its job from a private file, so the token never appears in shell history. It keeps the last lines of output, whole across split reads and split characters. It sends heartbeats until the result is taken. A closed tab can take the wrapper down soon after its hangup, so it reports as soon as the command ends or a moment passes, and `cardd` keeps only the first result. A 401 means the attempt ended and nobody waits.

### Review pages

- Lavish is a prerequisite of the fleet. `lavish.ts` checks that `lavish-axi` is on the `PATH` at or above its floor, 0.1.80, the first release whose `reply` confirms that the page took the answer. `fleet up` and `fleet restart` refuse without it, so main tells the captain about the host.
- `review.ts` is `wait_review`, which mirrors Firstmate's crew-hosted Lavish boards. The worker owns its page, but never polls it: a review job runs `lavish-axi poll` in its own tab through the `run_long` wrapper. A review job keeps the whole feedback, not the last lines, and waits up to a week.
- `cardd` opens the round's decision, key `review-<job>`, in the same transaction that records the job, so feedback can never come before its decision. The job's result is a `review-feedback` entry that answers that key, which ends the hold and sends the card back to work, as a mate's answer does. It stays off the board's thread: the captain wrote it on the page.
- Lavish's own next steps in the feedback say to poll the page again. The review job does that, so `inbox.ts` drops them and gives the fleet's next step.
- `report(done)` is refused while a review waits, so a worker cannot leave a page whose feedback nobody reads.

### Closing on the host

`closing.ts` runs close in this order: stop every writer (close the worker's workspace, which ends Pi and its job tabs), archive and verify all unlanded work, remove the worktree, then close the card. Each step finds its own result first, so a rerun converges. A worker may have moved its worktree to its own branch, which goes too, after the archive. An unreachable host of an attempt that no longer runs cannot be asked, and its work stays in place. A commit has landed when it is on the base branch or on `origin/<base>`, because dispatch branches from origin's base, which can be ahead of the clone's. `ORIGIN_BASE_IF_FETCHED` names that ref when it exists, and `archive.sh` does the same. `UNLANDED_COUNTS_SCRIPT` prints the commits not landed and the changed or untracked files: the worktree decides while it exists, and its branch after. `DELETE_ARCHIVED_BRANCH_SCRIPT` deletes the task branch once its work is archived or landed. It tolerates only a missing branch, and is safe to rerun. A local-only card lands first, as Firstmate's `fm-merge-local.sh` does: `LAND_LOCALLY_SCRIPT` fast-forwards the clone's base branch to the newest attempt's branch, only when the clone is on its base branch and clean and the branch is a fast-forward, and never pushes. Any uncommitted file in a worktree refuses it first, so a landing never leaves work behind. A rerun after a landing is a no-op fast-forward. Last, close refreshes the clones that `close.begin` lists (see Clones). It lists none for a local-only card, and main's first refresh skips local-only projects, as Firstmate's fleet sync does, because their local base branch is ahead of origin by design. A host that just failed to answer is already named in the outcome, so it is not waited for again.

### Clones

Clones keep up with their remote the way Firstmate's `fm-spawn.sh` and `fm-fleet-sync.sh` keep them. `sync.sh` is a POSIX port of `fm-fleet-sync.sh` and `fm-lock-lib.sh`, because a host's `sh` may be dash. It defines functions only, and each caller appends its own call.

- `dispatch.ts`: a new task branch starts at `origin/<base>`, fetched just now, with no tracking, so a push never goes to the base. A failed fetch, or an origin without the base, refuses the dispatch rather than start from a stale base. A clone with no origin starts from its own base. A rerun that finds the branch reuses it without fetching.
- `refresh_clone` fetches with `--prune`, deletes branches whose remote branch is gone unless a worktree has them checked out, and fast-forwards a clean base branch. It never forces, stashes, or discards. A clone that is dirty, on another branch, detached with its own commits, or diverged is left alone and printed as `STUCK`. A clean detached HEAD with no commits of its own goes back on the base. A folder inside another repository is skipped, because git looks upward and would refresh that one. A fleet home (it has `config/lane.json`) is only fetched: it moves with `/updatefleet`, which also builds and restarts.
- `fetch_origin` retries a fetch blocked by `packed-refs.lock` three times a second apart, since a live owner soon exits. It then removes the lock only when it is at least 30 s old and `lsof` proves that nothing holds it or the clone. Any doubt keeps the lock.
- `clones.ts`: `close.begin` lists every host's clone of a ship card's project. A scout changes nothing on the remote, as in Firstmate's teardown. Two host names can lead to one clone, so clones are refreshed in turn. A fetch over a slow link gets 120 s. Main refreshes every registered clone when it first joins `cardd`, as Firstmate's session start does, and wakes only for a `STUCK` clone, the one state that Firstmate's bootstrap diagnostics mark as needing attention. Other lines wait for main's next turn.

### Lanes and homes

- `homes.ts`: main's home is the repository. A second mate's home is a worktree, `<root>.worktrees/lane-<lane>`, that shares the root's installed packages. A lane is running (its mate is in the pane), down (it should run and does not), or stopped (held by hand or for crashing, so only `up <lane>` starts it). A lane that starts too often within a window is held. Naming a held lane lifts the hold and forgets its crashes. `--continue` keeps the mate's conversation across a restart. `direnv exec` loads the folder's `.envrc` and replaces itself with Pi.
- Starting a mate waits until Pi shows in the pane. Until then the pane looks idle, and a second `up` would type the command again.
- `lanes.ts`: each host runs its own `fleet` for its lanes. Main reaches its host directly and the others over their transport. A non-interactive shell does not expand `~`, so a remote checkout path is given whole. A host that cannot be reached is named, never skipped, and reported once until it answers.
- A worker never takes its model from its folder. The fleet repo's `.pi/settings.json` puts the mates on the orchestrator tier, and every worktree of the repo has that file. So unless `workerArgs` name a model, dispatch starts workers on Pi's global default model from the agent folder's `settings.json`.
- `titles.ts` owns the mates' names: `1stmate` for main, `2ndmate-<lane>` for a second mate. A mate gives its Pi session and its herdr workspace that name at start, so main gets it too, though the captain opens main's workspace by hand. Workspaces are still found by the earlier `fleet-<lane>` label, because a mate that started on earlier code keeps that label until it restarts.
- `lane-config.ts` reads `<home>/config/lane.json`. It is private because it holds the lane's token. `roots` defaults to `~/.fleet/app` for a remote host. `direnv` names a folder whose environment the mate runs in, while its home stays where it is.
- `update.ts` is one host's half of `/updatefleet`, run as `fleet update [--check]`. It prints one JSON line. `--check` fetches and finds every reason to refuse: a checkout off `main`, uncommitted changes, or commits that are not on `origin/main`, in the checkout or in any lane home. The update checks again, fast-forwards, runs `npm ci` when the lockfile changed or `node_modules` is missing, always builds the board, and moves each lane home to the new commit. The board build is cheap and makes a rerun converge after a failed build. A lane home moves only after the build, so a failed build leaves every mate on the code it runs. `fleet cardd` does the same for `cardd`'s checkout, and restarts `cardd` only when the commit that `cardd` reports running differs from the new one in `cardd`'s code, or is unknown. The running commit decides, not the pull, because a checkout can move without a restart, and a restart that failed must happen again on the next run. It backs up the database with `VACUUM INTO`, which copies a live WAL database consistently, just before the restart, since migrations run only when `cardd` starts. Pending migrations never run while the old `cardd` serves.
- `updating.ts` is main's half. It checks every host before it changes any, so a dirty home or an unreachable host stops the update with nothing pulled. Then it updates the hosts in turn, and stops at the first failure without restarting a mate. Then it updates `cardd`, and waits until `GET /api/version` answers with the new commit, which proves that the new process serves, not the old one. HTTP and not a session, because a second session with main's token would supersede main's own. Only when every host is updated and `cardd` runs the new code does it restart the lanes, as `lane("all", "restart")` does. Main restarts last. Pi cannot restart its own process, so a detached `relaunch.ts` waits for main's Pi to exit and its shell to be idle, then runs `pi --continue` with main's arguments in main's herdr pane. Main restarts when the turn that tells the captain ends. The command hands its report to main as a message that starts that turn, because Pi saves a conversation only once it has a reply, and `pi --continue` would otherwise start a new one.
- `migrate.ts` only copies, so a repeat never overwrites edits. Undoing renames the settings back and sets each home's `lane.json` aside.

### Memory

- `optchat.ts`: the memory loader, `~/.pi/agent/extensions/fm-optchat`, stays idle unless `FM_HOME` names Pi's own folder. A fleet home has no launcher to set it, so this extension loads the loader again with `FM_HOME` set, when the home has `config/optchat.json`. Pi evaluates a module each time it loads, so the second load sees the variable.
- `memory.ts` writes what the loader reads, all inside one home. Each step that is done already is left alone. The loader's helper runs only when its path is its real path. A profile's lock socket must fit a socket path: 104 bytes on macOS and 108 elsewhere, with the NUL.

### Calm

[calm.md](calm.md) owns what the captain sees. Inside:

- `layout.ts` patches the render of three Pi components. `ToolExecutionComponent` draws nothing, unless the row has an image, because an image is content. Without Pi's image list, a row counts as having images: showing a row is the safe error. `CustomMessageComponent` draws nothing for a `fleet` message. `AssistantMessageComponent` loses collapsed thinking and short pre-tool text from a shallow copy before layout. Pi's later refreshes read the full message back.
- Each patch probes the Pi member it replaces. `index.ts` skips a missing one with a diagnostic. A patch installs once per process. A reload evaluates the module again, so the flag lives in one process-wide object in `state.ts`.
- Calm sets Pi's hidden-thinking label to `""` while it is on, which is how `layout.ts` tells collapsed thinking apart. Setting the label, even to the same value, makes Pi lay out every assistant row again, which applies a toggle to rows already on screen. Without a terminal (print and RPC modes), calm only records its state.
- One logical run lasts from `agent_start` to `agent_settled`, which also covers abort and failure, so the boat does not flicker between tool calls.
- `preference.ts` replaces `config/calm` atomically, so a crash never leaves half a value. The choice is saved before the screen changes, so a failed write changes nothing.
- `ship-sprite.ts` owns the geometry, the bounce track, and the two linked cadences. Every tick moves the water a quarter cell, and every fourth tick moves the boat one cell, so the trough stays under the boat. Ticks, not wall time, drive every change. Hiding freezes the sprite at its last painted frame, and the next run resumes there. A fresh session resets it. State never sits in a module-level singleton. The boat at an endpoint already carries the new direction. A resize recomputes and clamps the track before the next frame.
- `ship.ts` paints runs with standard ANSI codes only: one blue for water, so the swell reads through glyph height, and one yellow for the whole boat. It recomputes the track from the render width on every frame. The widget key `calm-working-ship` is shared with Firstmate's calm and the standalone Pi calm, so a session that loads more than one shows a single boat. Its timer never keeps Pi's process alive.

## Board

- `App.tsx` reloads the board on every change and keeps only the newest load. It keeps what the captain started to write on each card when he goes back to the board.
- `route.ts`: each card has its own address, `#/c-21`. Opening a card adds a history entry, so Back returns to the board where it was scrolled.
- `format.ts` is pure. A card with a question for the captain needs him, whatever its status. The second mates' lane cards are the Mates group, not work.
- `icons.tsx`: each icon is decorative. The text next to it carries the meaning.

## End-to-end tests

- `e2e/support/scratch.ts` makes a scratch copy of the repository with its own lane homes. A home with a memory profile needs a short base folder, because the socket path must fit 103 bytes on macOS.
- `e2e/support/fake-model.ts` is a Pi extension that posts each model call to the test's control server and returns the move the test chooses. Everything else in Pi stays real.
- `e2e/support/herdr.ts` runs an isolated herdr session whose name starts with `fleet-lab-`, so a test never touches the captain's session.
- `e2e/support/remote.ts` gives a clone a bare remote, `<clone>.git`, and lands commits on it from another clone, as a merged PR does. The dispatch lab names its GitHub repository with `--repo acme/site`, so its clone needs no origin on GitHub: dispatch fetches any origin first. With `remote` set, the lab registers its clone for host `local` only, because the other lab hosts reach the same folder and would refresh it once each.
- A mate `Session` from `e2e/support/cardd.ts` acknowledges each entry it gets, as a mate whose runs end cleanly does, so the timed check never sends it anything again. `connect(token, inFile, false)` makes a mate that never takes anything in.
- `e2e/support/fake-gh.ts` keeps PR state in the JSON file named by `FAKE_GH_STATE`. A PR's repository is the owner/name in its URL, and `head` is the branch it was opened from, which `gh pr list --repo --head` matches. `broken` makes `gh pr checks` fail like a network error. `down` makes every call that reaches the PR fail. Every `Cardd` in the tests runs this fake gh, so no test reaches GitHub. The trial runs the real one.
- `e2e/support/flaky-transport.ts` behaves like ssh whose connection drops right after the worker started: the first `herdr agent start` that succeeds loses its output and exits 255. `switch-transport.ts` fails like an unreachable host once its marker file exists. A marker that starts with `hang` hangs instead, and one that starts with `flood` floods every command but herdr's.
- `e2e/extension/memory.test.ts` reads the private memory loader from a dotfiles checkout, `FLEET_DOTFILES` at `FLEET_DOTFILES_REF`. Without one, as in CI, it is skipped.
- `e2e/trial/trial.ts` is a real-model trial, not a test: `node e2e/trial/trial.ts <project clone> [model]`.
- `e2e/pi/contract.test.ts` pins the Pi behavior the extension depends on. A Pi upgrade that changes it fails there first.
- Tests that start processes stop every part even when one part fails, so no process outlives a test.
- A `cardd` token begins with `-` 1 time in 64. Tests force such tokens to prove that Pi reads each one as a value, not an option.
- `e2e/extension/dispatch.test.ts` bounds a restart below `FORMER_REFUSED_START_WAIT_MS`, the 10 s that a refused start once waited for a Pi that herdr never typed.
- `e2e/extension/start.test.ts` holds the worker's first model call open, so the worker stays busy while herdr's start command still waits for it to idle. The mate must hear back before that command ends. A clock on the whole dispatch would also count the shell's start and herdr's refusals, which load stretches.
- When a job's tab closes, either the wrapper posts what the command printed as it died, or the tab's processes go first and the heartbeat check reports the job lost. Which one wins depends on the platform and timing. `e2e/extension/jobs.test.ts` accepts either, once.
- `PINNED_LOADER_REF` in `e2e/extension/memory.test.ts` is the dotfiles commit whose loader labels a fleet message with just `[fleet]`, once (https://github.com/1yian/dotfiles/pull/35). Bump it when the loader changes. The model's turn may start with the memory's own context block, so the test finds the fleet message after it.
- `e2e/extension/worker-model.test.ts` starts main as a plain Pi in a scratch copy that picks its model from its settings, as the captain's does. Pi picks a model from its settings only when it knows a key for that model's provider at session start, so the test gives the scripted tiers a key. Main and its worker share the lab's model agent, so the system prompt tells their calls apart.
