# Firstmate rewrite: cards, one Pi extension, and a board

| | |
|---|---|
| Status | Draft for review |
| Date | 2026-10-19 |
| Scope | The `1yian/firstmate` fork, its second-mate homes, and its board |
| Owner | The operator of the fleet (in this document, *the captain*) |

This document specifies a rewrite of Firstmate. It is written for a reader who does not know Firstmate. It explains what Firstmate is, what problems the current version has, and the full design of the replacement.

The documents in this folder support this spec:

- `prompts/`: the instructions that the new agents load.
- `census.py` and `census.out`: a script that counts which current code the rewrite removes.
- `archive/`: earlier working drafts.

## Contents

1. [Summary](#1-summary)
2. [Background](#2-background)
3. [Problems](#3-problems)
4. [Goals and non-goals](#4-goals-and-non-goals)
5. [Design overview](#5-design-overview)
6. [Data model](#6-data-model)
7. [Card status and lanes](#7-card-status-and-lanes)
8. [Sessions](#8-sessions)
9. [Entries and delivery](#9-entries-and-delivery)
10. [Who receives what](#10-who-receives-what)
11. [Tools](#11-tools)
12. [Extension behavior](#12-extension-behavior)
13. [The timed check](#13-the-timed-check)
14. [Failure handling](#14-failure-handling)
15. [Hosts](#15-hosts)
16. [Second mates](#16-second-mates)
17. [Asks](#17-asks)
18. [Grants](#18-grants)
19. [Standing work](#19-standing-work)
20. [Delivery modes, validation, merge, and cleanup](#20-delivery-modes-validation-merge-and-cleanup)
21. [The board](#21-the-board)
22. [Prompts](#22-prompts)
23. [Comparison with Firstmate today](#23-comparison-with-firstmate-today)
24. [Code changes](#24-code-changes)
25. [Cutover plan](#25-cutover-plan)
26. [Verification status](#26-verification-status)
27. [Decision log](#27-decision-log)
28. [Defaults and tunable values](#28-defaults-and-tunable-values)
29. [Appendix A: Systems considered](#appendix-a-systems-considered)
30. [Appendix B: Measurements](#appendix-b-measurements)

## 1. Summary

Firstmate lets one person direct many AI coding agents through one conversation. The current version moves messages between agents with files, a background watcher, and a queue of wake-up events. This design is hard to see into, and work items get lost.

The rewrite keeps the conversation as the main interface. It changes the machinery under it:

- **Cards.** Each work item, decision, and promise is a card in one database. A card's status shows who must act next.
- **One Pi extension.** Each agent session loads the same extension. The extension delivers messages into the session and sends reports out. There are no inbox files and no watcher processes.
- **One store process.** A small server, `cardd`, owns the card database. It pushes new entries to connected sessions. It also runs one timed check every minute to catch what events miss.
- **Grants.** Standing permissions are data on a card or lane, not prose that an agent must remember.
- **Standing work.** Open-ended goals are cards that never close. A schedule on the card creates one run card for each scheduled run.
- **A board.** A web board shows every card. The default view lists everything that waits on the captain, and one click answers most items.

The rewrite removes about 241,000 of 394,000 tracked lines (61%). The new code stays small, but it has no fixed line limit.

## 2. Background

### 2.1 What Firstmate is

Firstmate is an open-source "agent distribution" (`kunchenguid/firstmate`). It is not an application. It is a set of instructions, skills, scripts, and file conventions. Any supported agent harness can load it.

One agent session acts as the **first mate**. The person who uses it is the **captain**. The captain talks only to the first mate. The first mate does not write code itself. It delegates each task to a **worker** (Firstmate calls workers *crewmates*). Each worker runs in its own terminal pane and its own isolated copy of the project (a git worktree). The first mate supervises the workers and tells the captain about outcomes and decisions.

A **second mate** is a persistent first mate for one domain, such as one product. It has its own folder (its *home*), its own backlog, and its own workers. The main first mate hands domain work to it with a comment on its lane card.

### 2.2 Key terms

| Term | Meaning |
|---|---|
| Captain | The person who directs the fleet. |
| Main | The main first mate: the captain's single point of contact. |
| Second mate | A persistent first mate that owns one domain. |
| Mate | Main or a second mate. |
| Worker | An agent that does one task in an isolated copy of a project. |
| Lane | The work area of one mate: its home, its cards, and its workers. |
| Home | The folder of a mate: its records, its memory files, and its project clones. |
| Pi | The coding-agent harness that every session in this design uses. |
| Pi extension | TypeScript code that Pi loads into a session. It can add tools, inject messages, and react to session events. |
| herdr | The terminal workspace manager that holds every agent pane. |
| no-mistakes | The validation pipeline. It reviews, fixes, tests, pushes, opens the PR, and waits for CI. |
| Lavish | A tool that shows an HTML review page to the captain and collects feedback. |
| Card | One work item, decision, or promise. |
| Entry | One event on a card, such as a comment or a report. |
| Status | The lane of a card on the board. It shows who must act next. |
| Grant | A recorded permission to act without asking the captain. |
| Standing card | A card for an open-ended goal. It never reaches Done. |
| Run card | A card that one scheduled run of a standing card creates. |
| `cardd` | The process that owns the card database. |

### 2.3 How Firstmate works today

```
captain ── chat ── main first mate
                     │ 1. writes a message file into the worker's inbox folder
                     │ 2. types a short "doorbell" line into the worker's pane
                     ▼
                   worker
                     │ 3. moves the file to handled/ (this is the acknowledgment)
                     │ 4. appends a status line to a status file
                     ▼
           watcher (one background loop per home)
                     │ 5. re-reads status files and pane screens
                     │ 6. classifies events and adds them to a wake queue
                     ▼
           wake queue ──► drained into the first mate's chat ──► acknowledged
```

Other parts of the current system:

- **Backlog.** A Markdown file per home. It has Queued, In flight, and Done sections.
- **Captain holds.** A backlog item can be held for the captain. This is the only stored record that the captain must act.
- **Status lines.** Workers append lines such as `done [at=<epoch>]: PR <url>`. The verbs are `working`, `note`, `done`, `failed`, `blocked`, `needs-decision`, `paused`, and `resolved`.
- **Current state.** A script (`fm-crew-state.sh`) calculates the state of a worker when asked. It reads the pipeline, the pane screen, and the status log.
- **Heartbeat.** The watcher wakes the first mate at intervals to review the whole fleet, even when nothing changed.
- **Supervision branch.** On Pi, a hidden second conversation screens wake events before main sees them.
- **Second-mate parent channel.** A second mate reports to main by appending lines to a status file in main's home.
- **Remote second mates.** Scripts carry messages and status files between machines over SSH.
- **Many harnesses.** The scripts support more than ten agent harnesses and five session managers.

### 2.4 The current deployment

| Machine | Role | Sessions |
|---|---|---|
| maverick (macOS) | Main home. Must stay awake. | Main first mate; second mate `cnp` (work under a separate identity). |
| P620 (Linux) | Remote homes. Sometimes rebooted for GPU tests. | Second mates `cleo`, `leo`, `board`, `concierge`. |

All sessions run in Pi inside herdr. The machines connect over Tailscale. The installed versions are Pi 1.3.0, herdr 0.9.0 on maverick, and herdr 0.9.5 on P620.

## 3. Problems

### 3.1 Message delivery is complex and hard to see into

A message from main to a worker passes through a file, a doorbell, a manual acknowledgment, a watcher, a queue, a drain, and a second acknowledgment. Each step can fail, so each step has its own retry and repair scripts. The captain cannot easily see why something woke or did not wake.

On 2026-10-19, the two machines ran 95 Firstmate background processes: 54 on maverick and 41 on P620. Examples are five watchers, five session-start supervisors, four SSH reply pollers, about 25 remote job workers, and two Lavish listeners that had run for three days. Twelve of the processes had leaked from tests and ran for up to 13 days.

### 3.2 Work and decisions get lost

The truth about one work item is spread across the backlog file, the status log, the inbox folder, the wake queue, and the chat history. Each home on each machine has its own copy of these. Nothing records who must act next, except for captain holds.

Evidence on 2026-10-19: the backlog showed six items "In flight". Four of them had reported `done` three to five days earlier. Nobody had acted on them.

The captain also loses decisions that live only in chat. For example, the first mate asks "Do you want me to make a task for this?" The captain does not answer, and the question is lost.

### 3.3 Ongoing work and permissions are added on

Firstmate has no concept for work that never finishes. The Cleo growth work (continuous Google Ads and SEO optimization) runs as three separate parts:

1. Cron jobs on P620 run scripts every hour and every day.
2. A custom watcher check wakes the second mate once a day for a review.
3. The permission ("You own the ads...") is prose in a memory file.

The only built-in standing permission is a per-project `yolo` flag that lets the first mate merge green PRs.

### 3.4 The system is large

| Item | Size |
|---|---|
| Tracked lines in the repository (binary files excluded) | 394,210 |
| Scripts in `bin/` | 215 |
| Always-loaded instructions (`AGENTS.md`) | 427 lines, 6,965 words |
| Skills | 28 skills, about 50,700 words |
| Instructions sent to each worker | about 2,900 words |

### 3.5 Earlier attempts

- **Transport redesign (2026-10-10 to 2026-10-12).** A 25-round design review replaced files with SQLite but kept the message model. Each round added back a part of the current system, such as receipts, cursors, and reminders. The captain stopped it after round 25.
- **A board over the current state.** A separate web board (`firstmate-board`, 27 merged PRs, about 8,000 lines) showed all tasks. It had to read many scattered sources. One refresh took 30 to 60 seconds. It did not stop work from getting lost.

The lesson: the transport is not the main problem. The problem is that no single record holds the state of each work item.

## 4. Goals and non-goals

### 4.1 Goals

1. Keep the captain experience. The chat with main stays the first-class interface. The captain can do everything by talking to main. The board is never required.
2. Keep one record for each work item, decision, and promise: a card. This includes work that never ends.
3. Show who must act next on every card, in a stored field that each event updates.
4. Remove inbox files, per-home watchers, the wake queue, and screen reading. Deliver messages inside each Pi session through one extension.
5. Catch what events miss with one timed check in one process.
6. Store every standing permission as a grant that the tools enforce.
7. Give the captain a board that is the visible source of truth and that takes fewer clicks than the chat for common actions.
8. Remove at least 200,000 tracked lines. Keep the new code small, without a fixed line limit.

### 4.2 Non-goals

- Support for harnesses other than Pi.
- Support for session managers other than herdr.
- Merges from the upstream repository. This rewrite is a hard fork.
- Use of an external tracker such as Plane or Linear.
- Conformance with the OpenAI Symphony specification.
- Away mode, the voice interface, and the extension binding host. These are removed.
- Direct Discord messages from `cardd`.
- More than one human user.

## 5. Design overview

```
        captain
        │      │
   chat │      │ browser (Tailscale only)
        ▼      ▼
      main   board ◄──────────────┐
        │                         │
        │      websocket + HTTP   │
        ▼                         │
 ┌──────────────────────────────────────────┐
 │ cardd  (maverick, launchd)               │
 │   cards.db (SQLite, one writer)          │
 │   timed check (every 60 s)               │
 └──────────────────────────────────────────┘
        ▲            ▲              ▲
        │            │              │   one websocket per session
   main (Pi)   second mates (Pi)  workers (Pi)
   maverick    maverick, P620     either host
   each session loads the "fleet" Pi extension
```

| Component | Description |
|---|---|
| `cards.db` | SQLite database. It holds cards, entries, lanes, projects, sessions, and delivery records. |
| `cardd` | The only writer of `cards.db`. It serves HTTP and websockets, pushes entries, runs the timed check, and serves the board. It runs on maverick under launchd. |
| `fleet` extension | A Pi extension that every session loads. It adds the tools, injects entries into the session, acknowledges delivery, reports activity, and applies guards and nudges. |
| Board | A React web app that `cardd` serves. Only the Tailscale network can reach it. |
| Prompts | `AGENTS.md` for mates, `worker.md` for workers, the task message, and skills. They ship in one Pi package. |
| herdr | Holds every pane. It creates worktrees and starts Pi in panes. |
| no-mistakes | The validation pipeline. Workers drive it. |
| `gh` | The GitHub CLI. The timed check uses it to read PR state. |

Install and update: Firstmate ships as one Pi package. Each host runs `pi install` once and `pi update` to upgrade.

## 6. Data model

### 6.1 Card

| Field | Description |
|---|---|
| `id` | Short identifier, such as `c-142`. |
| `title` | The outcome in the captain's words, such as "Users see one scrollbar on the Settings page". Never mechanics. |
| `lane` | The mate that owns the card. |
| `project` | The project from the registry. Empty for non-project work. |
| `kind` | `ship` (makes a project change), `scout` (makes a report), `captain` (a decision or action for the captain only), or `standing` (an open-ended goal). A second mate's lane card is a standing card ([section 6.3](#63-lane)). |
| `status` | The lane on the board. See [section 7](#7-card-status-and-lanes). |
| `held_until` | A date. Used with the Waiting status. |
| `return_status` | The status that the card goes back to when `held_until` passes. |
| `blocked_by` | Card IDs that must finish first. |
| `parent` | The parent card, such as the standing card of a run card. |
| `grant` | A grant for this card and its children. Empty means "use the lane grant". |
| `schedule` | Standing cards only. When runs occur. |
| `runner` | Standing cards only. `mate` or `worker`. |
| `intent` | The captain's own words for this card. |
| `spec` | The build instructions from the mate. |
| `delivery` | `no-mistakes`, `direct-PR`, or `local-only`. Ship cards only. |
| `base_branch` | The branch to start from and target. |
| `profile` | The model and effort for the worker. |
| `pr` | The PR URL, when one exists. |
| `attempt` | The current attempt. See [section 6.9](#69-attempt). |
| `revision` | A number that increases with each change to the card. Board actions carry it. |
| `last_activity` | When the worker last started or ended a turn or a tool call. |
| `created_at`, `updated_at` | Timestamps. |

### 6.2 Entry

An entry is one event on a card. The thread on the board and the activity log are the same list of entries.

| Field | Description |
|---|---|
| `id` | Unique entry ID. |
| `card` | The card. |
| `author` | `captain`, `mate:<lane>`, `worker:<id>`, `check` (the timed check), or `script:<name>`. |
| `kind` | `comment`, `report`, `ask`, `answer`, `status`, `merge`, `cleanup`, `connect`, `disconnect`, `finding`, `grant`, `note`, `job-result`, or `review-feedback`. |
| `body` | The text. |
| `fields` | Kind-specific data, such as the report status, key, `until`, ask options, `resolves`, `now`, or `quote`. |
| `attempt` | For entries by a worker or a job: the attempt that wrote it. |
| `created_at` | Timestamp. |

### 6.3 Lane

| Field | Description |
|---|---|
| `name` | Such as `main`, `cleo`, or `cnp`. |
| `home` | The home folder path. |
| `hosts` | The hosts where its sessions may run. |
| `charter` | The scope of the lane, used for routing. |
| `card` | The lane card. Second mates only. See below. |
| `grant` | The default grant for cards in the lane. |
| `parent` | `main` for second mates. Empty for main. |

One rule covers all communication: to talk to an agent, comment on its card. A worker's card is its task. A second mate's card is its **lane card**. `cardd` creates the lane card when it adds a lane with a parent, and a migration creates one for each existing second mate. It is a standing card named after the lane, owned by that lane's mate, and always open. It stays in Waiting, and only comments act on it. It cannot be dispatched, asked on, held, or closed. Main has no lane card, because nobody is above it.

### 6.4 Project registry

The registry is a table in `cardd`. All hosts can read it.

| Field | Description |
|---|---|
| `name` | The project name. |
| `clones` | The clone path on each host. |
| `delivery` | `no-mistakes`, `direct-PR`, `local-only`, or `no-mistakes-prod-only`. |
| `branch_prefix` | A required branch prefix, if any. |
| `default_base` | The default base branch. |
| `profile` | The dispatch profile: model candidates and effort. |
| `capacity` | The maximum number of workers at the same time. |

### 6.5 Session

| Field | Description |
|---|---|
| `id` | Session ID. |
| `role` | `mate` or `worker`. |
| `lane` | The lane. |
| `card` | The card of a worker. Empty for mates. |
| `host` | The host. |
| `token` | A secret that the session uses to connect. Dispatch issues it for one attempt. It stops working when that attempt ends or is replaced. `cardd` derives it from the session ID with a key that only `cardd` holds, so a dispatch retry gets the same token and `cardd` stores no token. |
| `state` | See [section 8](#8-sessions). |
| `low_water` | The highest entry ID below which every delivery record for this session is Confirmed. See [section 9.4](#94-delivery-records-and-recovery). |

### 6.6 Delivery record

| Field | Description |
|---|---|
| `entry` | The entry. |
| `session` | The recipient session. |
| `state` | Pending, Pushed, Acknowledged, or Confirmed. See [section 9.4](#94-delivery-records-and-recovery). |
| `updated_at` | Timestamp. |

### 6.7 Grant

| Field | Description | Example (Cleo growth) |
|---|---|---|
| `granted_by` | The captain's exact words, the date, and the source entry. | "You own the ads, no need to ask me", 2026-10-15 |
| `may` | Actions allowed without asking. | Keywords, negatives, bids, ad copy, campaigns, budget split, landing copy, tracking. |
| `limits` | Hard limits. | Spend at most a set amount per day. Bids at most a set amount. Do not change one page. |
| `always_asks` | Actions that always need a fresh answer. | Raise the budget. Anything destructive, irreversible, or security-sensitive. |
| `reports` | What the captain gets. | A weekly summary, and steps that only the captain can do. |
| `scope` | Optional project and branch. A scoped grant covers only cards for that project and branch. | None: the grant sits on the standing card. |
| `expires` | Optional end date. | None. |

### 6.8 Schedule

A schedule has one or more rules, such as "daily 09:00 America/Chicago: review" and "Monday 09:00 America/Chicago: weekly summary". A rule can mark its runs as summaries.

### 6.9 Attempt

An attempt is one execution of a card by one worker.

| Field | Description |
|---|---|
| `id` | The card ID plus a number, such as `c-142/a2`. All names derive from it: the herdr tab `c-142-a2` and the worktree folder `c-142-a2`. |
| `host` | The host. |
| `state` | Starting, Active, Ended, or Replaced. |
| `session` | The session and its token. |
| `pane`, `worktree`, `session_file`, `branch` | Where the attempt runs. |

Rules:

- A card has at most one attempt in Starting or Active.
- `cardd` creates the attempt and reserves project capacity in one transaction.
- The attempt ID is the retry key for `dispatch`. See [section 11.2](#112-mate-tools).

### 6.10 Job

A job is one `run_long` command.

| Field | Description |
|---|---|
| `id` | Job ID. |
| `attempt` | The attempt that started it. |
| `tab` | The herdr tab that runs it. |
| `state` | Running, Finished, or Lost. |
| `exit_code`, `output_tail` | The result, when Finished. |

### 6.11 Finding

A finding is one condition that the timed check reported.

| Field | Description |
|---|---|
| `key` | The card and the condition, such as `c-142/pr-merged` or `c-142/worker-stalled`. |
| `opened_at`, `cleared_at` | When the check reported it, and when the condition stopped. |

## 7. Card status and lanes

Each card has exactly one status. The status is also its lane on the board. It shows who must act next.

### 7.1 Statuses

| Status | Next actor | Meaning |
|---|---|---|
| Queued | The lane mate | The card exists. Work has not started. |
| Working | The worker | The worker implements, investigates, or reworks. |
| In review | The worker | The no-mistakes pipeline runs. The worker answers its gates. |
| With mate | The lane mate | A worker reported back or the timed check found a problem. The mate must act. |
| With first mate | Main | A second mate asked a question. Main handles it before the captain sees it. |
| Needs you | The captain | A question for the captain, or a "merge this PR?" approval. |
| Merging | The lane mate | The merge is approved by the captain or by a grant. The mate lands it. |
| Waiting | Someone outside, or a date | Held until a date, or blocked on an outside event. |
| Done | Nobody | Merged and cleaned up, or the report was delivered. Final. |
| Dropped | Nobody | Stopped on purpose. Unlanded work is archived. Final. |

The board shows the main flow from left to right: Queued, Working, In review, With mate, Needs you, Merging, Done. With mate and With first mate share one column, with a badge that names the mate. Waiting and Dropped sit to the side. Dropped is hidden by default.

### 7.2 Badges

Badges show details. They are not statuses.

| Badge | Shown when |
|---|---|
| Kind | Always: ship, scout, captain, or standing. |
| Paused until | The worker reported `paused` with a date. |
| Blocked by | The card has unfinished `blocked_by` cards. |
| Changes requested | The captain asked for changes on a PR. |
| Reviewers | A PR also needs review by other people, such as coworkers. |
| Grant | The card or lane has a grant. |
| Age | How long the card has had its current status. |

### 7.3 Transitions

| Event | New status |
|---|---|
| A card is created. | Queued |
| `dispatch` starts a worker. | Working |
| The worker reports `working`, `note`, or `paused`. | No change |
| The worker reports `in-review` (it started no-mistakes). | In review |
| The worker reports `done` on a ship card (PR green and ready, PR opened, or branch ready). | Merging if a grant covers the merge. Otherwise Needs you, with a merge question. |
| The worker reports `done` on a scout card (report written). | With mate |
| The worker reports `failed`, `blocked`, or `needs-decision`. | With mate |
| The worker ends a run without a report. The extension reports `stopped`. | With mate |
| The timed check finds a problem: worker lost, stalled, or never connected; PR closed without a merge; required checks failed while Merging. | With mate |
| A mate comments (a steer or an answer). | The status that the worker had before it handed off: In review if a pipeline still runs, otherwise Working. |
| Main's lane asks the captain. | Needs you |
| A second mate asks a question. It never reaches the captain directly. | With first mate |
| Main forwards the question with its own ask. | Needs you |
| Main answers from the record, or hands the question back. | With mate |
| The captain answers. | With mate. For a merge approval: Merging. For "request changes": Working, with the Changes requested badge. |
| The captain says "later", or a mate holds the card until a date. | Waiting. On that date the card goes back to `return_status`. |
| The merge is waiting for required checks. | No change (Merging) |
| Red checks or a merge conflict block the merge. | With mate. The worker's fix goes back through In review. |
| The PR merges, by `merge` or by hand on GitHub. | Merging, then Done after `cleanup` |
| `cleanup` with a summary. | Done |
| `drop` with a reason. | Dropped |

### 7.4 Transition guards

The transitions in [section 7.3](#73-transitions) apply only when these guards allow them:

1. **Closed cards stay closed.** `cardd` rejects reports, job results, and status changes for a Done or Dropped card.
2. **Only the current attempt counts.** `cardd` rejects reports from an attempt that ended or was replaced.
3. **Open captain questions stay visible.** While an ask on the card is open, worker reports do not move the card out of Needs you. They go on the thread and to the mate.
4. **Open decisions stay visible.** A comment moves the card back to the worker only if it resolves the last open decision key. See [section 17.5](#175-worker-decision-keys).
5. **Board actions are checked against the current card.** Each board action carries the card revision. If the card changed since the captain's view, `cardd` rejects the action, and the board shows the current card.
6. **Questions block closing.** `cleanup` and `card drop` refuse while an ask on the card is open. The mate resolves it first: the captain answers, or he agrees that it is moot.
7. **Done means landed.** `cleanup` moves a card to Done only for landed work: a merged ship, or a delivered report. Unmerged work that ends is Dropped.

### 7.5 Flow for each delivery mode

```
no-mistakes:
  Working ─ in-review ─► In review ─ done (PR green) ─┬─ grant covers merge ─► Merging ─ merged ─► Done
                           │                          └─ otherwise ─► Needs you ("Merge PR …?")
                           │                                            ├─ Approve & merge ─► Merging
                           │                                            └─ Request changes ─► Working
                           └─ ask-user findings ─► With mate ─ mate decides ─► In review
                                                               └─ needs the captain ─► Needs you ─► With mate ─► In review

direct-PR:   Working ─ done (PR opened) ─► Merging (grant) or Needs you. Merging waits for required checks.
local-only:  Working ─ done (branch ready) ─► Merging (grant) or Needs you. Merging fast-forwards local main.
scout:       Working ─ done (report written) ─► With mate ─ findings relayed, questions asked ─► Done
```

### 7.6 The progress rule

Every unfinished card must have one of these at all times:

- An actor with a pending action.
- A run in progress.
- A tracked wait with a defined wake condition.

| Status | The rule is met when | Enforced by |
|---|---|---|
| Queued | The card waits for a blocker or for a free slot in the project. Both wake the mate. Otherwise the mate dispatches it. | Timed check notice |
| Working, In review | The worker's run is in progress, or the worker waits on a tracked job or review, or it paused with a date, or an entry is waiting for delivery to it. | Run-end check ([12.3](#123-nudges)), timed check ([13.1](#131-what-it-does)) |
| With mate, With first mate, Merging | The mate has the next action. | Nudge, reminders, and a reminder to main after 15 minutes in With first mate |
| Needs you | The captain has the next action. | Board and widget. No reminders. |
| Waiting | `held_until` is set, or a PR state that the timed check reads. | `card hold` requires a date |

A progress report alone never meets the rule. A worker that reports `working` and ends its run, with nothing else pending, breaks it.

### 7.7 Standing cards

A lane card is a standing card with no schedule and no runs. It stays in Waiting for as long as the lane exists. It holds the conversation between main and the second mate.

A standing card stays in Waiting until its next scheduled run. Each run is a run card that moves through the normal statuses. An ask on the standing card moves the standing card to Needs you. After the answer, it goes to With mate and then back to Waiting.

## 8. Sessions

Every Pi session (main, second mates, and workers) has one state. `cardd` tracks the state from the websocket connection and from events that the extension sends.

### 8.1 Session states

| State | Meaning |
|---|---|
| Starting | Dispatch opened the pane and launched Pi. The extension has not connected yet. |
| Idle | Connected. No run is in progress. |
| Running | A run is in progress. |
| Waiting | Idle, but a `run_long` job or a `wait_review` is pending. This is not a stall. |
| Exited | The connection closed after a clean shutdown. |
| Lost | The connection dropped, or the keepalive failed. Causes are a crash, a frozen process, or a host that is down. |
| Closed | `cleanup` closed the session. Final. |

### 8.2 Session transitions

```
     dispatch, or control relaunch
                 │
                 ▼
           ┌──────────┐
           │ starting │
           └────┬─────┘
                │ the extension connects to cardd
                ▼
           ┌──────────┐   the run ends while a run_long job
     ┌────►│   idle   │── or a wait_review is pending ───────┐
     │     └────┬─────┘                                      ▼
     │          │ an entry is delivered,              ┌───────────┐
     │          │ or the captain types                │  waiting  │
     │          ▼                                     └─────┬─────┘
     │     ┌──────────┐                                     │ the job result or
     └─────│ running  │◄────────────────────────────────────┘ the review feedback
 run ends  └──────────┘                                       is delivered

 From any live state:
   the connection closes after a clean shutdown           → exited
   the connection drops, or the keepalive fails           → lost
   exited or lost  ── control relaunch ──►  starting  (same session file, same worktree)
   any state       ── cleanup ──►           closed
```

"Stalled" is not a state. It is a finding of the timed check: a running session has no activity for the stall threshold.

Mates are persistent. When a second mate is lost, main relaunches it. The relaunch limit is three per hour. After that, main tells the captain that the mate keeps exiting.

## 9. Entries and delivery

### 9.1 How a comment reaches a worker

This example shows a steer from a mate to a worker. All other entries use the same path.

1. The mate's model calls `comment(c-12, "use the v2 endpoint")`.
2. The mate's extension sends the comment to `cardd`.
3. `cardd` writes the entry and the new card status in one transaction. It finds the session that owns card `c-12`.
4. `cardd` pushes the entry over the websocket of that session.
5. The worker's extension checks the entry ID against its own session file. If a fleet message with this ID is already in the file, the extension stops here.
6. The extension calls Pi:

   ```ts
   pi.sendMessage(
     { customType: "fleet",
       content: "[fleet] Cleo on c-12: use the v2 endpoint",
       display: true,
       details: { entryId } },
     { triggerTurn: true, deliverAs: now ? "steer" : "followUp" });
   ```

7. Pi adds the message to the model context and writes it to the session file.
8. The extension sends an acknowledgment with the entry ID to `cardd`.
9. `cardd` marks the entry as delivered for this session. The board shows it as delivered.

The acknowledgment in step 8 is provisional. The session file is the authority for "the model has this message". See [section 9.4](#94-delivery-records-and-recovery).

### 9.2 Timing

| Session state | Result |
|---|---|
| Idle | `triggerTurn` starts a new run. The comment is the latest message. |
| Running, default | Pi queues the message as a follow-up. It arrives when the current run ends. |
| Running, with `now` | Pi delivers the message as a steer at the next tool boundary: after the current tool call ends and before the next model call. |
| Not connected | The entry waits in `cards.db`. When the session connects, recovery sends it. See [section 9.4](#94-delivery-records-and-recovery). |
| Crashed before the message reached the session file | Recovery sends the entry again, because the session file does not contain it. |

A `now` entry can reach the model before an older follow-up entry. This is intended: `now` means "this matters before the rest". Because of this overtaking, delivery does not use a single "highest delivered entry" cursor.

### 9.3 Delivery states of an entry

```
 written to cards.db
       │
       ├─ the recipient is not connected ──► held in cards.db ──► sent again by recovery on connect ─┐
       │                                                                                             │
       ▼ connected                                                                                   │
 pushed on the websocket                                                                             │
       │                                                                                             │
       ├─ the recipient is running ──► queued: after the run, or at the next tool boundary with now  │
       ▼ idle                                    │                                                   │
 injected, starts a run ◄────────────────────────┘◄──────────────────────────────────────────────────┘
       │
       ▼
 acknowledged: in the model context (provisional)
       │
       ▼
 confirmed: found in the session file at the next connect
```

"Delivered" is the last delivery state. Whether the recipient acted is not a delivery state. The card status records it. See [section 12.3](#123-nudges).

### 9.4 Delivery records and recovery

`cardd` keeps one delivery record for each pair of entry and recipient session. It does not keep a single cursor for each session.

| Delivery state | Meaning |
|---|---|
| Pending | The entry is for this session. It was not pushed, or the session was not connected. |
| Pushed | Sent on the websocket. No acknowledgment yet. |
| Acknowledged | The extension reported that Pi accepted the message. Provisional. |
| Confirmed | The extension found the message in its session file at a connect. Final. |

**Recovery at each connect:**

1. The extension reads its own session file from disk.
2. It collects the entry ID of every fleet message in the file (`custom_message` entries whose `details` hold an `entryId`).
3. It sends this list to `cardd`.
4. `cardd` marks those records Confirmed.
5. `cardd` sends every other record for this session again, in entry order, whatever its state. This includes Acknowledged records whose message is not in the file.

**Why the session file is the authority.** Pi 1.3.0 writes a message to the session file at `message_end`, after the extension handlers for that event run. But Pi does not create the file until the session has its first assistant message. Until then, every message is only in memory, even after the model received it. An acknowledgment, or any separate "already delivered" record, can therefore exist for a message that is not on disk. Only the message itself in the file proves that the model keeps it after a crash. The Pi contract tests (`e2e/pi/contract.test.ts`) show both facts.

**Rules that follow:**

- Duplicate suppression uses only the fleet messages in the session file. The extension keeps no separate list of delivered IDs.
- An entry is confirmed only when it is in the file. An acknowledgment alone never removes an entry from recovery.
- Pi writes the file with `appendFileSync` and no `fsync`. A Pi crash keeps the written lines. A host crash can lose the last lines. Recovery then sends those entries again, which is correct.
- After a relaunch, the session starts idle. A message that is in the file but has no answer stays in the model's history. The relaunch note from `control relaunch` starts a new run, and the model continues from that history.
- To keep recovery cheap, `cardd` keeps a low-water mark for each session: the highest entry ID below which all records are Confirmed. The extension reports only fleet messages above it.

### 9.5 What the model and the captain see

- **The model** gets the entry as a user-role message whose text starts with `[fleet]`. This is true for the OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages APIs. The instructions tell agents that `[fleet]` messages come from the fleet and that all other user messages come from the captain.
- **The session file** stores the entry as a `custom_message`, not as a user message. Code can therefore tell captain messages from fleet messages.
- **The captain**, when watching the pane, sees the message with a label (for example, "⚓ Cleo: use the v2 endpoint"). The extension registers a renderer for this.

Do not use `deliverAs: "nextTurn"`. In a test, it placed a fleet message after the captain's next message. The model then answered the fleet message instead of the captain.

### 9.6 Captain authority

These sources carry the captain's authority:

- User-role messages in main's chat. The captain types them, sends them from the board message box, or sends them from Discord through the existing bridge.
- Board actions: option clicks, comments, moves, and drops. They arrive at a mate as `[fleet]` messages that name the captain. An option click is recorded as the captain's words.
- User-role messages in any pane where the captain types directly. They override the card.

Code checks quotes. `answer` and `merge(quote)` accept a quote from only two sources. One is a user-role message in the calling mate's session file. The other is a board entry by the captain.

## 10. Who receives what

### 10.1 Delivery rules

| Entry | Delivered to | Starts a run? |
|---|---|---|
| Worker report `working` or `note` | Nobody. Board only. Exception: see [10.3](#103-first-report-after-a-comment). | No |
| Worker report `in-review`, `done`, `failed`, `blocked`, or `needs-decision` | The lane mate | Yes |
| Automatic `stopped` report | The lane mate | Yes |
| Mate `comment` on a card in its own lane | The worker on the card, if one is live | Yes |
| Main `comment` on a second mate's lane card, or on any card in that lane | That second mate, never its worker, at any card status | Yes |
| Second-mate `comment` on its lane card | Main | Yes |
| Main `ask` | The captain (board and widget) | No session |
| Second-mate `ask` | Main | Yes |
| Merge approval (`done` on a ship card without a covering grant) | The captain (board and widget), and one line to main | Main: yes |
| Captain answer, click, comment, or move on the board | The next actor after the entry | Yes |
| Timed-check finding | The next actor after the entry | Yes |
| Outcome in any lane (merged, done, dropped, or failed) | Main | Yes |
| Run card created by a schedule | The lane mate | Yes |
| `run_long` result or review feedback | The worker that waits for it | Yes |

### 10.2 What wakes main

Main runs only when the captain types or when its extension injects a `[fleet]` message. The extension injects when:

1. **A card in main's lane goes to With mate.** A worker in main's lane reports, stops without a report, or gets a timed-check finding.
2. **A second mate asks a question.** The card goes to With first mate.
3. **The captain must act in any lane.** For example, a merge approval from a second mate's lane. Main gets one line, so it can tell the captain in chat.
4. **An outcome lands in any lane.** A card is merged, done, dropped, or failed, or a summary run finishes. All four outcomes count, from every lane. The mate's summary comes with it.
5. **Something that main scheduled is due.** A `paused until` date passes, or a run card of one of main's standing cards is created.

These entries never wake main: `working` and `note` reports, tool activity, routine runs, and the work inside a second mate's lane.

The extension folds a burst of entries into one message. When main is running, the entries wait and arrive when the run ends.

### 10.3 First report after a comment

The first report from a worker after a mate's comment always reaches that mate, whatever its status. The extension delivers it together with the comment that it follows. For example:

```
[fleet] c-12 working: switched calls to the v2 endpoint (re your comment: use the v2 endpoint)
```

This lets the mate see quickly whether the worker followed the steer. No script decides whether the worker obeyed. The mate decides.

Only a comment that reached a session counts. A comment on a card with no live worker reached nobody, so no later report carries it.

The same echo covers main's comments to a second mate. After main comments on a lane card, or on a card in that lane, the second mate's next action on that card (a comment, an ask, a hold, a cleanup, or a drop) also reaches main, once, with main's comment:

```
[fleet] cleo on c-3: ads are under budget (re your comment: how are the ads doing?)
```

### 10.4 What the captain sees

The captain is not a session. The captain sees:

- The **Needs you** view on the board. It lists the questions that main has put to the captain, in every lane, and the merge approvals. A second mate's question that main has not forwarded is not there. Its card shows "With main" in Running.
- A **"Needs you: N"** widget in every mate's Pi screen.
- Main's chat. Main tells the captain about questions, outcomes, and findings.
- **"Since you were last here."** The captain sends a message after time away. Main's extension then adds two lists to that run: the outcomes since the captain's last message, and the Needs you list.

### 10.5 How a second mate's work reaches main

Worker reports in a second mate's lane go only to that second mate. Main does not see them and cannot steer those workers. Main talks to the second mate, with a comment on its lane card or on a card in its lane. That comment goes to the second mate at any card status. The second mate decides what its workers hear. Main hears four things from a second mate's lane:

1. The second mate's comments on its lane card, and its next action after a comment from main ([section 10.3](#103-first-report-after-a-comment)).
2. The second mate's questions (With first mate).
3. Finished cards, with the second mate's summary.
4. Escalations, when the second mate holds a card too long.

## 11. Tools

### 11.1 Worker tools

| Tool | Behavior |
|---|---|
| `report(status, text, key?, until?)` | Records a report on the worker's card. `status` is one of `working`, `note`, `paused`, `blocked`, `needs-decision`, `resolved`, `in-review`, `done`, or `failed`. The extension adds the time. It validates the status, the key format (`[A-Za-z0-9._-]+`), and `until` (UTC). A `paused` report without `until` gets a default `until` of 2 hours, unless a `run_long` job or a `wait_review` is active. It rejects `done` on a ship card if the latest commit is not on the PR branch (or, for local-only, on the named branch). |
| `run_long(label, command, timeout)` | Records a job in `cardd`, then runs the command in one named herdr tab that the captain can watch. Returns at once. A small wrapper runs the command. When the command ends, the wrapper posts the exit code and the last lines of output to `cardd` as an entry for the worker. Normal delivery and recovery bring the result to the worker, also after a Pi restart. The extension never runs a job again because a result did not arrive. If the tab and the result are both gone, for example after a host reboot, the timed check reports the job as lost. While the job runs, the session is Waiting, not stalled. |
| `wait_review(file)` | Waits for captain feedback on a Lavish page. The card goes to Needs you with the page link. The extension runs `lavish-axi poll` as a tracked child process. When feedback arrives, the extension writes it on the card and delivers it to the worker. If the worker restarts, the extension starts the wait again. |

### 11.2 Mate tools

| Tool | Behavior |
|---|---|
| `card new` | Creates a card in the caller's own lane. A card must exist before any work starts. A `lane` for another lane is refused, with a pointer to the lane card: main hands work to a second mate with `comment`, and the second mate creates its own card. |
| `card move` | Moves a card to another status, within the rules of [section 7.3](#73-transitions). |
| `card hold(card, until)` | Moves a card to Waiting until a date. |
| `card drop(card, reason)` | Ends a card that did not land. It follows the cleanup order in [section 20.5](#205-cleanup) and moves the card to Dropped. The reason is required. Refuses while an ask on the card is open. |
| `card promote(card, delivery)` | Changes a scout card to a ship card. The same worker continues. |
| `card handback(card, guidance)` | Main only. Returns a second mate's open question to that mate with guidance, and closes the question. It is not a general message: to say anything else to a second mate, use `comment`. |
| `dispatch(card, host?, profile?, replace?)` | Creates an attempt and reserves capacity in one `cardd` transaction. Then, over SSH on the host, it creates the worktree, starts Pi in a herdr tab, and sends the task message. Each step first checks whether its result already exists, by the names that derive from the attempt ID. A retry after a lost SSH connection therefore finds the attempt that already started. It does not start a second one. Refuses without a card, while the card has another attempt in Starting or Active, past the project capacity, or on a host that the lane does not allow. With `replace`, the current attempt becomes Replaced and its token stops working, so a late reconnect cannot change the card. |
| `comment(card or lane, text, resolves?, now?)` | Talks to an agent through a card. On a card in the caller's own lane, it goes to the worker. On a second mate's lane card, or any card in that lane, it goes from main to that second mate, never to its worker, with no status gate and no status change. A second mate's comment on its lane card goes to main. `lane` is shorthand for that lane's lane card, so main never looks up a card number. `resolves` names the decision key that the answer closes. It applies to a worker's card only. `now` delivers at the next tool boundary. |
| `ask(card, question, options)` | Asks the captain. From main's lane, the card goes to Needs you. From a second mate's lane, it goes to With first mate. |
| `answer(card, captain_words)` | Records the captain's exact words on a card, together with what they approve: the card and the action. Refuses if the words are not in a user-role message or a captain board entry. |
| `control(card or lane, interrupt or relaunch, note?)` | `interrupt` stops the current run. `relaunch` restarts Pi on the same session file, in the same worktree, with the note. Refuses while a live agent still owns the worktree. |
| `merge(card, quote?)` | Merges through the guarded path. Refuses red checks, required checks that have not reported, and merges without authority. `quote` is the captain's approving words when no grant covers the merge. |
| `cleanup(card, summary)` | Ends a card whose work landed. It follows the order in [section 20.5](#205-cleanup) and moves the card to Done. The summary is required. Main relays it to the captain. Refuses for unmerged ship work (use `card drop`) and while an ask on the card is open. |
| `grant(target, fields, captain_words)` | Sets or changes a grant on a card or lane. Refuses without the captain's words. |
| `board(filter)` | Reads cards. |

### 11.3 Script command

`fleet note <card> "<text>"` adds a note entry to a card. Scripts on cron use it to record their actions on a standing card. Scripts reach `cardd` with `POST /call` and a session token. The `run_long` wrapper uses the same path to post a job result.

## 12. Extension behavior

### 12.1 Connection

- At session start, the extension connects to `cardd` with its session token. It then runs recovery: it reports the fleet messages in its session file, and `cardd` sends every other entry for the session. See [section 9.4](#94-delivery-records-and-recovery).
- A mate gets a start briefing: its open cards, the cards with Needs you status, and its overdue runs.
- On a lost connection, the extension reconnects with backoff. Tools that need `cardd` return a clear error while it is unreachable.
- The extension restarts pending `wait_review` waits for its card.

### 12.2 Activity

The extension updates `last_activity` on the card at the start and end of each run and each tool call. This is a field update, not an entry.

### 12.3 Nudges

Pi fires `agent_before_settle` before a run ends. The extension can add one message there and request one more model call.

| Who | Condition | Action |
|---|---|---|
| Worker | The run ends with the card in Working or In review and without a handoff. See the run-end check below. | Add one nudge and request one more model call. If the rule is still not met when Pi fires `agent_settled`, file `stopped` with the worker's last message. The card goes to With mate. |
| Mate | A card that woke the mate in this run still has status With mate or Merging, and the mate did nothing on it. | Add one nudge. |
| Mate | The last assistant message asks the captain a question, and no `ask` ran. | Add one nudge to use `ask`. |

**Run-end check for workers.** At `agent_before_settle`, the run may end only if at least one of these is true:

1. **Handoff.** Since its last input, the worker reported `done`, `failed`, `blocked`, or `needs-decision`. These move the card to the mate or to the captain. `working`, `note`, `resolved`, and `in-review` alone are not handoffs.
2. **Tracked wait.** A `run_long` job runs, a `wait_review` is pending, or the worker reported `paused` with an `until` date in the future.
3. **Continuation.** A message is already queued for the session. The check reads `context.pendingMessages` in the event. An entry that `cardd` has not yet delivered to the session also counts.

In Pi 1.3.0, `agent_before_settle` is the last point where an extension can add entries and request one more model call. `agent_settled` is notification only. Pi fires it when no retry, compaction, or queued continuation will run. The Pi contract tests confirm both facts.

If the captain stops the run with Escape, `agent_settled` reports `aborted: true`. The extension then files `stopped` with the note "stopped from the pane". This usually means that the captain stepped in. The mate checks the pane before it steers the worker.

The nudge guard resets only when new captain input or a new fleet entry arrives. It must not reset on `agent_start`, because the nudge's own extra run fires `agent_start` and would loop.

Mates never get an automatic `stopped`. A mate that holds a card may be thinking or waiting. The timed check sends reminders instead.

### 12.4 Guards

The extension uses Pi's `tool_call` event to catch these actions as ordinary agent mistakes:

| Session | Blocked actions |
|---|---|
| Worker | Merging a PR. Pushing to the default branch. Writing into another worktree. Creating, removing, or pruning worktrees. Stopping, restarting, or updating the no-mistakes daemon. |
| Mate | Writing to a project, except through the guarded tools. Steering a worker in another lane. Merging without authority. |

These guards are not a security boundary. Pi runs with the permissions of the account that started it and has no sandbox. A guard sees a direct tool call. It does not see what an allowed script does inside. The rules that must hold are enforced where the operation happens:

- `cardd` checks each request against its session token. A worker can change only its own card, and only from its current attempt. Only mates can dispatch, merge, grant, clean up, or drop.
- `merge` checks authority and required checks.
- Domain functions enforce domain limits, such as the growth loop's `apply_ops`.
- GitHub enforces branch protection, required checks, and merge queues where a repository uses them.

All sessions share one operating-system account and one set of credentials, as today. Separate credentials for each worker are a non-goal.

### 12.5 Widget

Every mate's Pi screen shows "Needs you: N" through `ctx.ui.setWidget`.

## 13. The timed check

### 13.1 What it does

The timed check is one pass inside `cardd` every 60 seconds. It reads only `cards.db`, plus `gh pr view` for open cards that have a PR.

| It finds | It writes on the card |
|---|---|
| A worker in Starting for more than 2 minutes | Status With mate: "worker never connected" |
| A worker card in Working or In review whose session is not connected | Status With mate: "worker not connected" |
| A running worker with no activity for the stall threshold | Status With mate: "worker stalled" |
| A card in Working or In review whose worker session is Idle (not Waiting) for 2 minutes, with no future `paused` date and no undelivered entry | Status With mate: "worker idle without a handoff". This is the backup for the run-end check. |
| A card in With mate whose mate is not connected | A notice to main. If the mate is main, the card waits for main. |
| A card in With mate or Merging with no action for 30 minutes | A reminder to that mate. Then reminders after 1 hour, 2 hours, and every 4 hours. Only while the mate is idle. |
| A second mate holding a card for 2 hours | An escalation to main. |
| A card in With first mate for 15 minutes | A reminder to main. The question stays with main. |
| A PR merged | Status Merging, and a notice to the lane mate to run `cleanup`. |
| A PR closed without a merge | Status With mate. |
| A card in Merging whose required checks failed | Status With mate. While a card is In review, the no-mistakes pipeline handles CI itself. |
| `held_until` passed | Status `return_status`. |
| A `run_long` job whose tab and result are both gone | Status With mate: "job lost". The job is not run again. |
| A schedule rule due | A new run card under the standing card. Not created if the previous run card is still open. |
| A queued card whose blockers are all Done, or whose project gets a free slot | A notice to the lane mate. |

The captain never gets reminders. The captain sees the Needs you view and gets the "since you were last here" list.

### 13.2 Rules

- Each finding is an entry. It goes through normal delivery. The board shows why something woke.
- The check wakes nobody when everything is in order. It spends no model tokens on empty check-ins.
- The check is idempotent. Each finding has a key: the card and the condition. The check writes a finding only if no open finding has the same key. A finding clears when its condition stops or the card changes status. A condition that stays true, such as "PR merged" while cleanup waits, is therefore reported once. After that, the mate's reminders apply.
- The check never reads pane screens or status files.
- All timers live in the timed check. The only exceptions are the websocket keepalive and the `paused until` date that the worker's own report sets.

### 13.3 Why there is a timed check

Events alone are only as reliable as every event handler. A missed event leaves a card stuck with nobody to notice. Also, nothing sends an event when a PR merges on GitHub, when CI finishes, or when a schedule is due. A level-triggered check fixes these cases. OpenAI Symphony uses the same idea.

The current watcher is expensive for four reasons. It runs as five processes on two machines. It reads screens. It uses a queue with acknowledgments. It wakes the model on a heartbeat. The timed check does none of these.

## 14. Failure handling

| Failure | Mechanism | Trigger |
|---|---|---|
| A worker finishes, and nobody reviews the work. | The `done` report moves the card to Merging or Needs you. The card cannot stay in Working. | The report |
| A question for the captain scrolls away in chat. | Mates ask only through `ask`. The question is a card in Needs you. | The tool call |
| A mate asks in plain chat anyway. | One nudge to use `ask`. | `agent_before_settle` |
| The captain forgets to answer. | The widget count, the Needs you view, and the list that main adds on the captain's next message. | The captain's own message |
| A mate does not act on a card. | One nudge, then reminders, then escalation to main for a second mate. | `agent_before_settle`, timed check |
| A worker ends a run without a report. | One nudge, then an automatic `stopped` report. | `agent_before_settle`, `agent_settled` |
| A worker reports progress (`working`) and ends its run with nothing pending. | Same as above: a progress report is not a handoff. The timed check is the backup after 2 minutes. | `agent_before_settle`, `agent_settled`, timed check |
| A worker ignores a steer. | The first report after the comment reaches the mate with the comment. The mate decides and recovers the worker. | The next report |
| A worker crashes. | The connection closes. The mate confirms with `herdr agent get` on the worker's host and relaunches on the same session file. | Socket close |
| A worker never connects. | The timed check moves the card to With mate. | Timed check |
| A worker hangs in a tool, or its Pi freezes. | No activity for the stall threshold. The keepalive also drops a frozen process. | Timed check, transport |
| A mate, a worker, or `cardd` is down. | Entries wait in `cards.db`. Recovery delivers them at the next connect. The timed check flags cards whose next actor is not connected. | Reconnect, timed check |
| A card is dropped or moved to Done while its worker runs. | The worker's extension stops the run. The mate runs `cleanup`. | The card move |
| A PR merges or CI fails outside the tools. | The timed check reads the PR. | Timed check |
| A scheduled run is missed. | The run card stays open and overdue. Its mate is reminded. | Timed check |
| A worker's host is unreachable. | The card waits in With mate. The card is never run again on another host without an explicit new attempt. | Timed check |
| `dispatch` loses its SSH connection after the worker started. | The retry finds the existing attempt by its ID and does not start a second one. | Retry |
| A replaced attempt reconnects. | Its token no longer works. `cardd` rejects its reports. | Connect |
| A late report arrives for a Done or Dropped card. | `cardd` rejects it. | Report |
| The captain clicks an option on an outdated card. | The revision does not match. The board shows the current card. | Board action |
| The worker pushes a commit after a merge approval, such as a rebase or a conflict fix. | Allowed. The approval covers the PR. `merge` still refuses red checks and required checks that have not reported. | Merge |
| Pi restarts while a `run_long` job runs. | The job posts its result to `cardd`. Recovery delivers it. The job never runs again only because a result did not arrive. | Job end |
| A message is delivered twice. | The extension skips entry IDs whose fleet message is already in its session file. | Delivery |
| A newer `now` entry is acknowledged before an older follow-up, then Pi crashes. | Delivery records are per entry, not one cursor. Recovery sends every entry that is not in the session file, including the older follow-up. | Connect |
| Pi crashes after it accepted a message but before it wrote the message to the session file. | The acknowledgment is provisional. Recovery finds the message missing from the file and sends it again. | Connect |

## 15. Hosts

Any session can run on any host. The websocket to `cardd` is the only cross-host channel for delivery and for liveness. Every host therefore works the same way.

- **`cardd` location.** `cardd` runs on maverick under launchd. Main lives there, and maverick already must stay awake. To move it, move one SQLite file.
- **Dispatch to a host.** `dispatch(card, host)` connects to the host over Tailscale SSH. On that host it runs `herdr worktree create`, then `herdr pane run` to start Pi with the fleet environment, and then sends the task message. There is no remote job worker, remote entrypoint, or file transfer.
- **Allowed hosts.** Each lane lists the hosts where its sessions may run. The lane's environment (direnv) and project clones must exist on each one. For example, `cnp` runs only on maverick. `cleo` runs on P620, and on maverick for iOS work, which needs macOS. `dispatch` refuses other hosts.
- **herdr IDs.** herdr pane and agent IDs are unique only within one herdr server. A card therefore stores the host with every herdr ID.
- **Watching panes.** The captain adds each host once with `herdr machine add`. One herdr window then shows live panes on all machines.
- **Versions.** herdr versions must match on all hosts. `herdr machine add` refuses an incompatible server. Pin herdr in the dotfiles.
- **Unreachable host.** The card waits. A rerun on another host is a new attempt that the mate starts explicitly with `dispatch(..., replace)`. The old attempt then cannot change the card, even if its host comes back. This rule comes from the SSH appendix of the Symphony specification.
- **No process on each host.** herdr can push pane events, but only on a local socket on each host. Using those events would need a subscriber process on every host. The design therefore queries herdr only when needed, over SSH.

## 16. Second mates

- A second mate owns one lane: a home folder, a charter, a direnv environment, memory files, and a herdr pane. Main and second mates start with `optpi`, which keeps conversation memory in the home folder. Workers start with plain `pi`.
- A second mate acts only on cards in its lane. These cards are its own: it creates them when main comments on its lane card with work, when its own standing cards' schedules are due, or when the captain types in its pane. After a restart, it checks its own cards and then waits. An empty lane never permits a survey, an audit, or an improvement sweep.
- The second mate handles its workers' reports and decisions. It applies the same rules as main.
- Its questions for the captain go to main first. See [section 17](#17-asks).
- Its finished cards reach main with its required summary.
- Its chat is not a channel to the captain. Anything for the captain goes through `ask` or a card summary. When the captain types in its pane, it answers there and records decisions on the card.
- Main creates cards only in its own lane, under its own supervision. It hands work to a second mate with a comment on the lane card, quoting the captain's words. The second mate creates its own card and dispatches it, or answers on the lane card. Main cannot dispatch a second mate's card or steer its workers.
- A second mate answers main with `comment` on its lane card. Its chat is not a channel.

## 17. Asks

An ask is a question that belongs to the captain. It is a card with the Needs you status and a list of options.

### 17.1 Creating an ask

- Every unresolved question that belongs to the captain must become an ask before the work that found it finishes. This includes questions from investigations, reports, and Lavish reviews.
- Ask on the card that the question blocks. Create a new card only when none exists. Link the new card to the card that found the question.
- Make one ask for each real decision point. A review with several questions is one ask that points to the report.
- Findings that are already resolved and recommendations that need no choice are not asks.
- Write each ask so that it stands alone: evidence first, then the consequence, the options, and a recommendation.
- Do not ask "Do you want me to make a task for this?" Create the follow-up card in Queued with a recommendation. Ask only if the start needs the captain's permission.

### 17.2 Questions from second mates

1. A second mate calls `ask`. The card goes to With first mate.
2. Main handles it in its next run in one of three ways:
   - **Answer from the record.** The captain already decided this, or a grant or a recorded preference covers it. Main calls `answer` with the captain's earlier words and their source. The card goes to With mate in the second mate's lane.
   - **Hand back.** The question is not the captain's to decide. Main calls `card handback` with guidance. This closes the question. Other messages to the second mate are comments on the lane card.
   - **Forward.** The question belongs to the captain. Main calls `ask` and adds a recommendation and any context from other lanes. The forward replaces the second mate's question, so the captain answers one question. The card goes to Needs you.
3. The captain's answer goes directly to the card. It does not pass back through main.
4. If main does not act within 15 minutes, the timed check reminds main. The question stays with main. Only main's own `ask` reaches the captain, so nothing reaches the captain except through main.

Merge approvals skip this step. Main cannot approve a merge without the captain's words or a grant, so a filter adds nothing. They go directly to Needs you, and main gets one line.

### 17.3 Answers

- A click on a board option records the captain's choice on the card.
- When the captain answers in chat, the mate calls `answer` with the captain's exact words before it acts. Never close anything that the captain owns without the captain's words.
- "Later" is an answer. The card goes to Waiting until the date.
- When an answer changes what a card must build, the mate adds the captain's words to the card's intent and comments them to the worker. On a card in a second mate's lane, main comments the captain's words on the card. They reach the second mate, who steers its worker.

### 17.4 Questions that become moot

If evidence shows that an ask no longer matters, the mate writes the evidence on the card and tells the captain. The mate closes the ask only after the captain agrees.

### 17.5 Worker decision keys

A worker can have more than one open decision. Each has a key. A decision stays open until a `comment` with `resolves=<key>` answers it, or the worker reports `resolved` with the same key. A later `done` or `working` report never closes an open decision.

A comment that resolves one key moves the card back to the worker only if no other key is open. Otherwise the card stays With mate, with a badge that shows the number of open decisions.

## 18. Grants

A grant is a recorded permission to act without asking the captain. See the fields in [section 6.7](#67-grant).

- **Inside a grant**, act without asking. Log each change, with its undo, on the card.
- **Outside a grant**, call `ask`.
- **Where a grant sits.** On a lane (the default for all its cards) or on a card (for that card and its children). Child cards inherit the grant of their parent.
- **Changes.** Only `grant` with the captain's words changes a grant. Never widen a grant by analogy. Never apply it to another card or action. Never turn one request into standing permission.
- **Scope.** A grant can name a project and a branch. A scoped lane grant covers only cards for that project and branch.
- **Precedence.** A card uses the first grant that applies, in this order:
  1. The card's own grant.
  2. The grant of its parent card.
  3. A lane grant whose scope matches the card.

  An expired grant does not apply. Grants do not combine: the first match is the whole grant.
- **Merge permission.** Each per-project `yolo` flag of the current system becomes a lane grant scoped to that project. An example is "may merge when CI is green, project `firstmate-board`". The scope stays, so the permission never extends to other projects in the lane. `merge` reads the grant.
- **Enforcement.** Enforce hard limits in code where possible. `merge` enforces merge rules. A project's own guard enforces domain limits. For example, the growth loop's `apply_ops` function enforces the spend limits.
- **Display.** The board shows each card's grant: what runs without asking and what asks first.
- **Initiative.** Work beyond a request is permitted only inside the goal and grant of a standing card.
- **Expiry.** A grant can have an end date. A temporary "while I am away, you may ..." permission is a grant with an expiry. This replaces away mode.

## 19. Standing work

### 19.1 Standing cards

A standing card holds an open-ended goal. It never reaches Done. It ends only when the captain drops it. A standing card needs:

| Field | Example (Cleo growth) |
|---|---|
| Goal | Booked demos at the lowest cost per demo. "Book a Demo" clicks are the measure. |
| Procedure | `data/cleo-growth/REVIEW.md` |
| Grant | See [section 6.7](#67-grant). |
| Schedule | Daily review at 09:00 America/Chicago. Weekly summary on Monday at 09:00. |
| Runner | `mate` (the mate does each run) or `worker` (each run gets a new worker). |
| Reports | The weekly summary (spend, clicks, demo clicks, booked demos, cost per demo, changes), and steps that only the captain can do. |

A mate must not create a standing card or its grant without the captain's own words for the goal and the permission.

### 19.2 Runs

1. When a schedule rule is due, the timed check creates a run card under the standing card. The run card's status is With mate.
2. The mate does the run, or dispatches a worker, as the runner field says.
3. The mate or worker follows the procedure, acts inside the grant, and logs each change with its undo on the run card.
4. The run card ends with a short result: what was measured, what changed, and why.
5. A summary run is an outcome. It reaches main, and main tells the captain in plain terms.

A missed run is an overdue run card. Do the run late, or write why it was skipped. Never fill in missed runs silently. The timed check does not create a new run card while the previous one is open.

Each run is a separate card for these reasons:

- Each run has its own log and result.
- Missed runs are visible.
- The mate's chat does not grow with every review.

This follows the Symphony approach, where the tracker creates a new ticket for each recurring task.

### 19.3 Limits and scripts

- Actions outside the grant are asks on the standing card.
- Steps that only the captain can do, such as logins or access, are asks on the standing card.
- Changes to the goal, grant, or schedule need the captain's words.
- Mechanical loops stay as scripts on cron. They record their actions with `fleet note`. To add or remove such a script, dispatch a worker.
- To stop the work, the captain drops the standing card. This stops the schedule. A worker then removes its cron scripts.

### 19.4 Cleo growth today and after the rewrite

| Today | After the rewrite |
|---|---|
| Cron on P620: `run.sh guard` every hour, `run.sh daily` at 08:20 | Same cron jobs. They write notes on the standing card. |
| A custom watcher check (`state/cleo-growth-review.check.sh`) prints "daily review due" after 09:00 and "weekly summary due" every 7 days | Schedule rules on the standing card. Each run is a run card. |
| Review state in hidden files (`.review-last`, `.summary-last`) | Run cards and their results |
| The permission is prose in `data/captain.md` and `REVIEW.md` | A grant on the standing card that quotes the captain |
| Changes logged in `data/cleo-growth/changelog.jsonl` | Same log, plus a short entry on each run card |
| The growth work is not on the backlog. The nearest item is a one-time audit that has been In flight since 2026-10-14. | One standing card with its runs and child cards folded under it |

## 20. Delivery modes, validation, merge, and cleanup

### 20.1 Intake

- Find the project for each request. An explicit project wins. A clear follow-up uses the earlier project. Otherwise, match against the registry, open cards, and project code. Ask one short question only when several projects or no project match.
- Route by the type of work against each second mate's charter: comment on that second mate's lane card with the captain's words. Keep local-only work in main's lane.
- Check existing reports and cards before you start an investigation.
- Classify the card. A **ship** card is the default and makes a project change. A **scout** card makes a report. Use a scout only when the captain asks for a knowledge deliverable, or when an unresolved question could change whether or what to build.
- A diagnosis or a recommendation does not permit code changes.
- Fill the card:
  - **Intent:** the captain's own words, plus the content of any report or PR that the words refer to. Do not widen it. Reviewers treat it as the acceptance criteria.
  - **Spec:** only the build instructions that the request needs. Name what is out of scope. Extra hardening that the captain did not ask for becomes a separate queued card.
  - **Delivery mode:** the captain's current instruction, or else the registry setting. On a `no-mistakes-prod-only` project, internal tooling, process, and release work uses `direct-PR`. Product, mixed, or unclear work uses `no-mistakes`. An unregistered project uses `no-mistakes` with no merge grant, and the mate tells the captain about the gap.
  - **Grant:** the lane grant, unless the captain says otherwise.
- Dispatch independent cards at once, even when files overlap. Use `blocked_by` only for a real dependency, shared outside state, or migrations that conflict.
- Model choice: the project's dispatch profile. When a profile lists several models, the quota-aware procedure (`quota-array-dispatch`) chooses among Pi provider and model pairs.
- Effort: the captain's choice wins. Otherwise, use low effort for well-understood work, very high effort for unclear investigation or design, and levels between for other work. Never use the maximum effort without the captain's preference.

### 20.2 Delivery modes

| Mode | Worker does | Ready signal |
|---|---|---|
| `no-mistakes` | Implements and commits. Reports `in-review`. Starts the pipeline with `run_long`. Answers gates. Confirms the PR is not a draft. | `done: PR <url> checks green` |
| `direct-PR` | Implements, commits, pushes, and opens a ready PR. | `done: PR <url>` |
| `local-only` | Implements on a branch. Keeps it a clean fast-forward onto the default branch. Never pushes. | `done: ready in branch <branch>` |

Do not add a separate reviewer or a manual approval step on top of a mode. If a fast mode needs more checks, ask the captain whether to use `no-mistakes`.

### 20.3 Validation rules

- The worker that starts a no-mistakes run drives it to the end. The mate never answers a gate for the worker.
- Never pass `--yes` or `-y` to no-mistakes.
- The worker never answers its own "ask-user" findings. It writes them, word for word, to a findings file. It reports `needs-decision` with the key `nm-<run>-<step>` and stops. The mate decides with the `ask-user-authority` procedure, or asks the captain. The mate answers with `comment(..., resolves=<key>)`.
- The mate decides a finding when it agrees with the accepted intent. The mate asks the captain in these cases:
  - A fix would expand the contract, for example with new guarantees, subsystems, frameworks, or monitoring.
  - The intent does not settle a product call.
  - Findings with the same theme keep returning.
  - The choice is destructive, irreversible, or security-sensitive.
- The `--intent` value contains only the captain's words from the card, plus the content of anything they refer to. It never contains the spec or the worker's own decisions.
- New requirements during a run go to follow-up cards. Exception: a current captain instruction that makes the work under validation invalid. The worker then stops the run with the supported abort, follows the pipeline's custody recovery, rebuilds from the correct base, and validates once.
- Judge a run by `no-mistakes axi status` and the card, not by whether a shell is alive.
- Only a refused or missing daemon socket, or a run that failed with a daemon error, shows that the daemon is down. A timed-out call does not.

### 20.4 Merge

- A merge needs the captain's explicit words for that PR, or a grant that covers it.
- Never merge red checks or required checks that have not reported.
- Destructive, irreversible, or security-sensitive merges always need the captain's words.
- Merge only with `merge`. It records the merge on the card.
- An approval covers the PR, not one commit. After approval, the worker may make small changes at its own discretion, such as a rebase, a merge-conflict fix, or a CI fix. `merge` still requires green required checks on what it merges. A change that alters what the PR delivers needs the captain's word again. The mate decides when a change is that large.
- When a repository uses required checks or a merge queue, `merge` follows them. The fleet does not build its own merge queue.
- After a merge by a grant, main tells the captain in one line with the full PR URL.

### 20.5 Cleanup

`cleanup(card, summary)` and `card drop(card, reason)` use the same steps, in this order:

1. Stop all writers: end the worker's Pi session and the attempt's `run_long` jobs. Every attempt of the card is retired, including replaced ones.
2. Pack all unlanded work into one archive file on the worker's host, next to the project clone: `<clone>.archive/<session>.tar.zst`. The archive is compressed with `zstd -19`. It holds:
   - Every commit on the task branch that is not on the base branch, as a git bundle. This includes pushed commits that are not merged.
   - Staged and unstaged changes, as two binary patches.
   - Untracked files that are not ignored.
   - A manifest.
3. Verify the archive with `git bundle verify` and a test decompression.
4. Record the host and the archive path on the card.
5. Remove the worktree and the pane.
6. Set the final status: Done for `cleanup`, Dropped for `card drop`.

`cleanup` is only for landed work: a merged ship or a delivered report. Unmerged work that ends is Dropped, even when its archive is complete. Neither operation refuses because of unlanded work. If a step fails, the operation stops and the mate investigates. Never delete an archive.

### 20.6 Scouts and promotion

- A scout writes a report that stands alone. The report says what the scout did, what it found (with evidence), and what it recommends. Its final section is "Decisions for the captain".
- The mate relays the findings, not only "done". The mate turns each decision into an ask, creates queued cards for recommended work, and runs `cleanup`.
- For a Lavish review, the worker stays alive and uses `wait_review` for each round.
- When implementation is approved, `card promote` changes the scout to a ship card. The worker then:
  1. Returns to a clean copy of the base branch.
  2. Keeps only the intended fix.
  3. Creates its branch.
  4. Turns a reproduced bug into the regression test.

## 21. The board

### 21.1 Principles

- The chat with main is the first-class interface. The board is never required. Main never sends the captain to the board for something the captain asked for in chat.
- The board is the visible source of truth. It shows `cards.db` directly. It does not rebuild state from other records.
- Each common action must take fewer clicks than the same action in chat.

### 21.2 Views

| View | Contents |
|---|---|
| Board (default) | Three groups as columns: Needs you, Running, and Done. Needs you holds every card with a question for the captain, in every lane, with each question and its option buttons inline. Merge approvals show "Approve & merge" and "Request changes". Done shows the 20 most recent finished or dropped cards. Under the three groups, a Mates section shows each second mate's lane card, with the latest comment on it. The lane cards are not in the three groups. A lane filter and a project filter. Standing cards show their grant, their last and next run, and their child cards folded. A "since you were last here" summary appears at the top. |
| List | The same groups, one after another. A narrow screen always gets the list. |
| Card | Each card shows its title, its latest news in one line, its status, its lane, and its PR. It opens in place, never as a separate page or a drawer. Open, it shows one line for each update, and each line opens to its details. It also has a reply box, move and hold controls, and a "watch live" action. "Watch live" copies the herdr command that attaches to the worker's pane. |

A card's thread shows what the captain reads: the captain's words, the mates' notes, questions, and outcomes, and the workers' reports. Job results, the timed check's findings, and the mate's instructions to the worker (the task message and its steers) stay out. On a lane card the mates' comments are the talk between main and the second mate, so they show. Nothing on the board scrolls sideways.

A **message box** on every view sends text into main's chat as a captain message. The board therefore never becomes a second conversation.

### 21.3 Click budget

| Action | Clicks |
|---|---|
| See everything that waits on the captain | 0 (the default view) |
| Answer a question or approve a merge | 1 click or 1 number key |
| Reply on a card | 1 key (`r`) and the text |
| Hold or drop a card | 1 drag |
| Talk to main | Type in the message box |

### 21.4 Behavior

- The board updates live over the `cardd` websocket.
- Each common action has a keyboard key.
- The board works on a phone.
- Each board action reaches the next actor as a `[fleet]` message that names the captain. It carries the captain's authority.
- The board is reachable only on the Tailscale network. `cardd` binds to the Tailscale address and refuses `0.0.0.0`.

### 21.5 Components

The board uses React and the free, MIT-licensed components of AffectUI. Each component is one React 19 file with no other dependencies. Install each one with:

```sh
npx shadcn@latest add https://www.affectui.com/r/<slug>.json
```

| Board part | Component |
|---|---|
| Needs you list | New code. Decision Inbox allows only two answers, and a question can have more. |
| Card thread | New code: one line for each update, which opens to its details |
| Worker activity | Tool Call Card |
| "Since you were last here" | Change Summary |
| Lane and project filters | Filter Menu |
| View switcher | Segmented Control |
| Inbox groups, cards, and grant display | New code |

The paid AffectUI components (Agent Inbox and Autonomy Dial) are not used and not copied. Their download endpoint requires a license key. The inbox follows the look of the public Agent Inbox demo, in new code.

The board needs a build step (Vite).

The board leaves out these parts of the old board: the embedded terminal, image drop, and hover previews.

## 22. Prompts

The new instructions are in `prompts/`. They ship in the Pi package.

| File | Loaded by | Contents |
|---|---|---|
| `AGENTS.md` | Main and second mates | Identity and captain address; hard rules; cards and status; tools; intake; delivery and merge; handling fleet messages; grants and standing work; how to talk to the captain; knowledge files; captain instruction precedence. |
| `worker.md` | Workers | Identity; message sources; the report verbs; `run_long` and `wait_review`; rules for isolation, branches, pushes, shared infrastructure, and project memory files. |
| `task-message.md` | `dispatch` | The template of the worker's first message: the card, the captain's intent, the spec, and one "Definition of done" block for no-mistakes, direct-PR, local-only, or scout work. |
| `skills/` | Mates, at stated triggers | Ported: `ask-user-authority`, `validation-supervision`, `ship-landing`, `scout-completion`. Replaced: `asks` (was captain holds), `worker-recovery` (was stuck-crewmate recovery). New: `standing-work`. |
| `skills.md` | Reviewers | The fate of each of the 28 current skills. |

### 22.1 Rules that the prompts keep from Firstmate

- Main is the captain's single point of contact and never does project work itself.
- Hard rules: never write to a project; never merge without authority; never discard unlanded work; workers never address the captain; report outcomes truthfully.
- Address the captain as "captain" in chat, never in commits, PRs, or code. Light nautical words are optional.
- Talk in outcomes, not mechanics. Never show internal terms such as card IDs, statuses, worktrees, or tool names to the captain.
- The final message of a turn stands alone. It includes outcomes, decisions needed, and full PR URLs.
- Escalations put evidence first, then the consequence, the options, and a recommendation.
- A current, explicit, concrete instruction from the captain overrides any standing rule, exactly as stated and no further.
- Knowledge routing:
  - Domain preferences go in the lane's `data/captain.md`.
  - Shared preferences go in main's `data/captain-shared.md`.
  - Local facts go in `data/learnings.md`.
  - Project knowledge goes in the project's own `AGENTS.md`. Only humans add to it.

### 22.2 Rules that tools now enforce

| Old prose rule | New enforcement |
|---|---|
| Ask the captain in a durable way | `ask` is the only way to ask. The mate gets a nudge if it asks in plain chat. |
| Record the captain's exact words before closing a decision | `answer` verifies the words against the session file or a board entry. |
| Do not widen standing permissions | `grant` refuses without the captain's words. |
| A ready signal must name a pushed commit | `report` rejects `done` if the latest commit is not pushed. |
| Write a status line at each phase change | The extension nudges, then files `stopped`. |
| Acknowledge each inbox message | The extension acknowledges delivery automatically. |

### 22.3 Size

| | Today | New |
|---|---:|---:|
| Always-loaded contract | 427 lines, 6,965 words | 147 lines, about 2,500 words |
| Instructions per worker | About 2,900 words | About 700 words, plus the card and one "Definition of done" block |
| Skills | 28 skills, about 50,700 words | 4 ported, 2 replaced, 1 new, 1 kept unchanged, 9 to adapt during the build, 12 cut |

## 23. Comparison with Firstmate today

### 23.1 Messages to workers

| Function | Firstmate today | New design |
|---|---|---|
| Steer a worker | `fm-send`: a file and a doorbell line | `comment` |
| Keep a message for a worker that is down | The inbox file waits | The entry waits in `cards.db` |
| Acknowledge | The model moves the file to `handled/` | The extension acknowledges on `message_start` |
| Handle an unacknowledged message | The watcher rings again and escalates | Redelivery on reconnect; the timed check flags a silent worker |
| Close a decision with the answer | `fm-send --resolve-key` | `comment(..., resolves)` |
| Interrupt or relaunch | `fm-control` | `control` |
| Urgent steer | Implicit | The `now` flag |

### 23.2 Reports from workers

| Function | Firstmate today | New design |
|---|---|---|
| Report | Append a line to a status file, with a typed time stamp | `report`, with an automatic time stamp |
| Verbs | `working`, `note`, `done`, `failed`, `blocked`, `needs-decision`, `paused`, `resolved` | The same eight, plus `in-review` (the pipeline is running) |
| A run ends without a report | The watcher raises a "no-verb" signal | One nudge, then an automatic `stopped` |
| A report reaches the mate | Watcher, queue, drain, and acknowledgment | Pushed and delivered into the chat |

### 23.3 Session state

| Function | Firstmate today | New design |
|---|---|---|
| Current state | `fm-crew-state.sh` calculates it from the pipeline, the pane screen, and the status log | The connection and Pi's own events give it directly |
| A stuck worker | "Stale" wakes with an escalation count, plus the heartbeat | The timed check's "stalled" finding |
| A dead worker | Dead-endpoint detection | Lost connection |

### 23.4 Who must act next

Firstmate stores this only for the captain, as a hold on a backlog item. Everything else it calculates when asked: the wake drain prints "OPEN DECISIONS", and `/bearings` builds a "Captain's Call" list. Nothing records that a mate must act after a worker reports `done`. The new card status stores who must act next for every card, and each event updates it.

### 23.5 Second mates

| Function | Firstmate today | New design |
|---|---|---|
| Route work | A marked message with a correlation ID | A comment on the second mate's lane card. The mate creates its own card. |
| Facts reach main | Scripts copy worker `done`, `failed`, and PR-ready lines to main as they happen | Main hears only after the second mate finishes the card, with its summary |
| Questions for the captain | A line in the parent-channel status file. Main relays it in chat. | `ask` goes to main first (With first mate), with a 15-minute reminder to main. Only main's ask reaches the captain. |
| Answers | Main relays them back with a marked message | The answer goes directly to the card |
| A missing reply | `fm-pending-reply`: one recovery request, then one escalation | Nudge, reminders, then escalation to main |
| Repeated crashes | Automatic relaunch, then "keeps exiting" | Relaunch, with a limit of three per hour |

### 23.6 New items

- A stored "next actor" status on every card, with the With mate and With first mate statuses.
- A nudge to the worker before the automatic `stopped` report.
- The `in-review` verb.
- The `now` flag for urgent steers.
- The rule that the first report after a comment reaches the mate.
- Structured grants, standing cards, run cards, and the board.

### 23.7 Removed items

- The wake queue, its drain, and its acknowledgments.
- Doorbells and the move-to-acknowledge step.
- Screen reading and the busy-state contract.
- Heartbeat model turns.
- The supervision branch.
- Correlation IDs and markers.
- The captain-hold binding and reconciliation machinery, and the record-divergence check.
- Away mode and quiet mode.
- The voice interface.
- The extension binding host.
- All harnesses except Pi, and all session managers except herdr.

## 24. Code changes

### 24.1 Census

`census.py` sorts every tracked file by its fate in the rewrite. Unmatched files count as "keep", so each "cut" number is a lower limit. To run it:

```sh
python3 data/fm-rewrite/census.py
python3 data/fm-rewrite/census.py --files cut-transport   # list the files in one group
```

| Group | All lines | Excluding tests |
|---|---:|---:|
| Cut: delivery, wake, watcher, supervision, custom checks, process events | 141,526 | 55,404 |
| Cut: backlog, holds, crew state, snapshots | 33,010 | 11,492 |
| Cut: harnesses other than Pi | 26,458 | 11,610 |
| Cut: away mode, voice interface | 16,554 | 6,665 |
| Cut: remote relay, remote provisioning, configuration inheritance, self-update, treehouse | 9,438 | 5,524 |
| Cut: session managers other than herdr | 8,689 | 2,911 |
| Cut: extension binding host | 5,246 | 2,964 |
| Rewritten as new code: spawn, teardown, brief, dispatch, home seeding, `AGENTS.md` | 30,406 | 15,257 |
| Kept: PR and merge scripts, no-mistakes support, mail, X mentions, calm UI, lint and test tools | 122,883 | 53,039 |
| **Total cut** | **240,921 of 394,210 (61%)** | |

The separate `firstmate-board` repository (about 8,000 lines) is archived.

### 24.2 New code size

The new code has no fixed line limit. The quality gates keep each part small: at most 500 lines in a file, 100 lines in a function, and a complexity of 10. The first build steps showed that the earlier limits (600 lines for `cardd`, 1,000 for end-to-end tests) were too low for code that passes these gates with full end-to-end coverage.

### 24.3 Kept features

- PR and merge support for GitHub, Forgejo, GitLab, and Gerrit.
- no-mistakes run support.
- Mail, and X mentions (Relay).
- Lint and test tools, and the herdr lab tools.
- The calm Pi UI. It now renders `[fleet]` messages.
- The Discord bridge for main's chat.
- The quota-aware model choice.

## 25. Cutover plan

The cutover is one wave. There is no compatibility layer and no period with both systems.

1. Build `cardd`, the extension, the board, and the new prompts in a new public repository, `1yian/fleet`, under strict quality gates. Port each kept feature into it only when it passes the same gates. The Firstmate fork runs the fleet until the switch, and then it is archived. The cut groups are never copied.
2. Import the current records once for each home:
   1. Open backlog items, holds, and in-flight workers become cards. In-flight cards get the Needs you status and their last status line.
   2. Per-project `yolo` flags become lane grants scoped to their project.
   3. Standing permissions in each `data/captain.md` become grants that quote the same words.
   4. Custom watcher checks become schedules on standing cards. Cleo growth is the first.
3. Run end-to-end tests in an isolated herdr lab:
   1. The captain asks main, a worker asks a question, the captain answers on the board, the worker opens a PR, the merge happens, and cleanup runs.
   2. The same flow through a second mate on P620, including a second-mate question through With first mate.
   3. A standing card with a one-minute schedule: run cards appear, a missed run shows as overdue, and an action outside the grant becomes an ask.
   4. Kill a worker, `cardd`, and main during the flow. Confirm that nothing is lost.
   5. Overtaking: queue entry A as a follow-up while the worker runs a long tool call. Send entry B with `now`. Let B reach the model. Kill Pi before A is delivered. Relaunch. Confirm that recovery delivers A exactly once and does not deliver B again.
   6. Persistence boundary: dispatch a new worker and kill Pi before its first model reply, while the session file does not exist yet. Relaunch. Confirm that recovery delivers the task message again.
   7. Kill Pi between Pi's acceptance of a message and the end of that turn. Confirm that the message is delivered again only if it is not in the session file.
   8. Dispatch retry: cut the SSH connection after Pi starts and before `dispatch` gets the result. Retry. Confirm one attempt, one pane, and one worktree.
   9. Replaced attempt: replace an attempt on another host, then reconnect the old one. Confirm that `cardd` rejects its reports.
   10. Stale board click: change a card in chat, then click an old option on the board. Confirm that the click is rejected.
   11. Job across a restart: kill Pi while a `run_long` job runs. Relaunch. Confirm that the result arrives once and the job does not run again.
   12. Keep the evidence as reviewable artifacts. Do not write unit tests.
4. Switch: stop the old watchers, restart every mate with the extension, and archive the old `state/` and `data/` folders as tar files.
5. Rewrite `VISION.md`: Pi only, herdr only, a hard fork, and standing permissions as grants.

## 26. Verification status

### 26.1 Proven in an earlier prototype

The design review of 2026-10-10 to 2026-10-12 built a scratch prototype: Pi sessions with a fake model, connected to a small server. It showed these results:

- A steer sent during a tool call arrived after that tool call ended. The model acted on it.
- The delivery acknowledgment can use `message_start` with the ID in `details`. Custom messages do not fire Pi's `input` event.
- A message sent while a worker was closed arrived after a relaunch on the same session file.
- Killing the server with `kill -9` during a run lost no events.
- The model receives custom messages as plain user-role messages on OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages.
- `deliverAs: "nextTurn"` put a fleet message after the captain's next message. Do not use it.
- The no-report nudge and the automatic `stopped` report work. The nudge guard must reset only on new input, or the nudge loops.
- `cleanup`'s archive-then-close step worked in a scratch copy.

### 26.2 Proven on Pi 1.3.0

`e2e/pi/contract.test.ts` runs real Pi 1.3.0 processes with a scripted fake model. It shows these results:

- A steer sent during a tool call reaches the model after the tool call and before an older follow-up. The follow-up comes after the next model reply.
- A fleet message is in the session file while the model call that received it is still running. A crash then keeps the steer on disk, and the queued follow-up is in neither the file nor the context.
- Before the first assistant message, the session file does not exist. A message that the model already received is lost in a crash.
- `agent_before_settle` can return `continue: true` with a custom-message entry. The model gets one more call that contains the entry.
- `agent_settled` reports `aborted: true` after an abort.

`e2e/extension/worker.test.ts` runs a real worker (Pi with the fleet extension) against a real `cardd`. It shows these results:

- Delivery tests 5 and 6 of [section 25](#25-cutover-plan): after a crash, recovery delivers the older follow-up once and does not repeat the newer steer. A message lost before the session file existed is delivered again.
- A `cardd` restart does not repeat a message that the worker already holds.
- The run-end check: one nudge, then `stopped` with the worker's last message. An abort files "stopped from the pane".

`e2e/extension/dispatch.test.ts` runs a mate Pi that dispatches a worker Pi into an isolated herdr lab session. It shows these results:

- Dispatch adds each attempt's own git worktree and branch, and opens a herdr workspace for it under its mate's workspace. `herdr agent start` starts Pi there with the fleet flags, and refuses a pane that is not at a shell prompt.
- herdr counts an agent as ready only when it idles, and a worker starts on its task at once. So dispatch does not wait for herdr: a Pi in the pane's foreground means it started, and a pane that runs Pi is never started again (`e2e/extension/start.test.ts`).
- Cutover test 8: when the connection drops after the worker started, the retry finds the same attempt. There is one worktree, one agent, and one task message.

`e2e/extension/jobs.test.ts` runs a worker Pi whose `run_long` job runs in a herdr lab tab. It shows these results:

- While a job runs, the run may end without a nudge. The result arrives as a `[fleet]` message.
- Cutover test 11: when Pi is killed while a job runs, the job finishes, its result reaches the relaunched worker once, and the job does not run again.

### 26.3 Not yet proven

- Delivery between maverick and P620 over Tailscale.
- `herdr machine add` for watching panes on both hosts.

The first end-to-end tests must cover these items.

## 27. Decision log

| Decision | Reason |
|---|---|
| Rewrite the model, not only the transport. | The earlier transport redesign returned to the same machinery. The missing part is one record for each work item. |
| Full cutover, no pilot lane. | The captain's choice. It avoids a period with two systems. |
| Pi only and herdr only. | The captain uses only these. It removes about 35,000 lines. |
| No fixed line limit for new code. | The captain's choice. The quality gates keep each part small, and the earlier limits were too low for full end-to-end coverage. |
| Messages through a Pi extension, not a polling watcher. | The captain's choice. The extension injects messages directly into the session. |
| One store process (`cardd`), not zero. | The fleet uses two machines and one board. SQLite cannot be shared over the network. The alternative (one database per home and direct calls between extensions) rebuilds the current remote relay. |
| `cardd` on maverick. | The captain's choice. Main lives there, and maverick already must stay awake. |
| One timed check. | Events alone cannot catch missed handlers, PR merges, CI results, or schedules. |
| A run card for each scheduled run. | Each run gets its own record. Missed runs are visible. Mate chats do not grow. |
| Grants replace prose permissions. | Firstmate's own vision calls standing permission "scoped consent" that never widens. Today only `yolo` is enforced. |
| One status field, not a status plus a separate next-actor field. | One field is simpler. Each status already names the next actor. |
| "In review" means agentic review (no-mistakes). Human approval is in Needs you. | The captain's choice. |
| One rule for communication: comment on the agent's card. A second mate has a standing lane card. Main creates cards only in its own lane. | Main had no way to reach a second mate except a new card, and a comment on a lane card was refused. That led to dropped cards and lost words. A card for each agent gives one verb for every edge, and the captain can read the main to second-mate talk on the board. |
| Rework is a badge, not a lane. | A change request usually means "fix what I commented", not "start again". |
| Second-mate questions go to main, and only main's ask reaches the captain. After 15 minutes main gets a reminder, and the question does not move on. | The captain's rule: nothing is surfaceable to him except through main. Main filters, removes duplicates, and adds recommendations. A limit that forwarded the question itself broke that rule. |
| Merge approvals go directly to Needs you. | Main cannot approve a merge alone, so a filter adds nothing. |
| All outcomes from every lane reach main. | The captain's choice. |
| Main hears a second mate's work only after the card is finished. | One owner for each card, and less noise. Questions still reach the captain at once. |
| A progress report is not a handoff. A worker run can end only with a handoff, a tracked wait, or a queued continuation. | A worker that reports `working` and goes idle would otherwise hold its card with nobody to act. Firstmate's watcher covers this case today, so the rewrite must too. |
| Delivery records for each entry and recipient, confirmed from the Pi session file. No single cursor. | A `now` entry can overtake an older follow-up, so a "highest delivered" cursor can skip the older entry. An acknowledgment can precede the write to disk, so only the message in the file proves delivery. |
| Attempts with names that derive from the attempt ID. The attempt ID is the retry key. No separate table of commands. | A retry must find work that already started. With derived names, each step checks for its own result and reuses it. A command table would add state without a new guarantee. |
| Findings have a key: the card and the condition. | A condition can stay true without a status change. |
| The status stays one stored field, with seven transition guards. It is not calculated from every open obligation. | The guards cover each case that review found. A full calculation would add more code than it removes risk. |
| Tool guards catch mistakes. Rules that must hold are enforced at the operation: `cardd`, `merge`, domain functions, and GitHub. No separate credentials for each worker. | Pi has no sandbox. The trust model stays as today: one user on the user's own machines. |
| A merge approval covers the PR, not one commit. No pinning to a head commit. | The captain trusts agents with small follow-up changes, such as rebases and conflict fixes. A new approval for each such change would only add friction. Green required checks still apply. |
| A new repository, not a branch of the fork. | The kept code (about 123,000 lines) does not meet the new quality gates. A new repository applies the gates from the first commit and makes the cut automatic: nothing is copied unless it is ported. |
| No fleet merge queue. | GitHub's required checks and merge queues already exist. |
| Mates have no automatic `stopped` report. | A mate that holds a card may be thinking or waiting. Reminders are enough. |
| `cleanup` and `drop` need a summary. | The summary replaces the judgment lines that second mates wrote to the parent channel. |
| No supervision branch. | The card status keeps routine events out of main's chat. |
| No away mode. | The captain's choice. The captain had already told the first mate not to use it, because on Pi it stopped outcomes from reaching chat. |
| No Discord message from `cardd` when main is down. | The captain's choice. Findings wait on the board. |
| Voice interface removed. | It came from upstream and was not used. |
| Extension binding host removed. | No plug-ins were installed. Pi packages cover the need. |
| Quota-aware model choice kept. | The captain's choice. |
| Project registry in `cardd`. | Dispatch can then work from any host. |
| Own board, not Plane. | See [Appendix A](#appendix-a-systems-considered). |
| React with free AffectUI components. | The captain's choice. The paid components are not used. |
| No conformance with Symphony. | Conformance requires the Codex app server, a polling loop, a `WORKFLOW.md` file, and automatic reruns until done. These conflict with the goals. |

## 28. Defaults and tunable values

| Value | Default |
|---|---|
| Timed check interval | 60 seconds |
| A worker counts as never connected after | 2 minutes in Starting |
| A worker counts as idle without a handoff after | 2 minutes Idle while its card is Working or In review |
| Default `until` for a `paused` report without a date | 2 hours |
| Stall threshold (no activity while running) | 15 minutes |
| Mate reminders | 30 minutes, then 1 hour, 2 hours, and every 4 hours, only while the mate is idle |
| Escalation of a second mate to main | 2 hours |
| Reminder to main for a question in With first mate | 15 minutes |
| Relaunch limit for mates | 3 per hour |
| Burst folding window | About 1 second of quiet |
| Websocket keepalive | 30 seconds |

Open items: none. Nine skills and the calm UI code must be adapted during the build. `prompts/skills.md` lists the changes.

## Appendix A: Systems considered

### OpenAI Symphony

Symphony is an open specification for orchestrating coding agents (`openai/symphony`). An issue tracker such as Linear is the control plane. A long-running service does these steps:

1. It polls the tracker for active issues.
2. It creates a workspace for each active issue.
3. It runs a Codex app-server session in the workspace.
4. It keeps the agent working until the issue reaches a done or hand-off state.

On each tick, a reconciliation pass stops runs whose issues became inactive. It retries failed runs with backoff.

What this design takes from Symphony:

- The tracker (here, `cards.db`) is the source of truth.
- A level-triggered check catches what events miss.
- Each task gets its own isolated workspace.
- When a card is dropped or done while its worker runs, the worker stops.
- A run on another host is a new attempt, never a silent failover (from its SSH worker appendix).
- Recurring work is a new card for each run.
- The lane names In review and Merging (from its Human Review and Merging states, with "In review" redefined as agentic review).

What it does not take: the Codex app server, headless workers without live panes, `WORKFLOW.md`, automatic reruns until done, and in-memory state for blocked issues. The Symphony reference implementation clears its blocked-issue map on restart.

### Plane

Plane is a self-hosted project tracker. It was rejected for these reasons:

- Its webhooks need a publicly reachable URL. They refuse private addresses. They switch off after five failed deliveries. Pushing events into live Pi sessions would therefore need a relay process, or polling of its API. The default API limit is 60 requests per minute for each key.
- It needs PostgreSQL, Redis, RabbitMQ, and object storage, with at least 4 GB of RAM.
- Its states and assignees would be a second model to map onto card statuses.

### Linear

Linear was considered earlier. It runs only in the cloud. Its free plan allows 250 issues, and the backlog has about 650. Work under the separate identity must not go to an outside service.

### AffectUI

AffectUI is a library of React components for agent products. Forty components are free under the MIT license. The board uses six of them. The paid components are not used.

### Pi Herdsman

Pi Herdsman is an open-source Pi extension for asynchronous sub-agents in herdr. The earlier design review used it as a reference. This design keeps two of its principles: messages go only along direct parent-child edges, and runtime state comes from fresh evidence, not from memory.

## Appendix B: Measurements

All measurements are from 2026-10-19.

| Measurement | Value | Method |
|---|---|---|
| Firstmate background processes | 54 on maverick, 41 on P620 | `ps` on both hosts |
| Leaked processes | 12: one test fixture for 13 days, and 11 test processes from a deleted folder for 2 to 4 hours. All were stopped. | `ps`, parent process ID 1 |
| In-flight items with an old `done` report | 4 of 6, reported 3 to 5 days earlier | Backlog and status files |
| Tracked lines | 394,210 (binary files excluded) | `census.py` |
| `AGENTS.md` | 427 lines, 6,965 words | `wc` |
| Skills | 28, about 50,700 words | `wc` |
| Worker instructions | About 2,900 words | A generated brief |
| Old board refresh | 30 to 60 seconds | Its README |
| Largest scripts | `fm-spawn.sh` 5,851 lines; `fm-teardown.sh` 3,977; `fm-watch.sh` 3,364; `fm-wake-lib.sh` 2,921 | `wc -l` |
