# The neglect view

Every open work card carries a `pulse`: who has it, whether anything runs for it now, when it last moved, and what it waits on. `cardd` computes it. The board, the Pi pane, and main's reminders read the same field, so none of them keeps its own limit.

A standing card (a lane home or a schedule holder) and a closed card have no pulse.

## The pulse

| Field     | Meaning                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `state`   | One word that sums the card up. See the table below.                                                 |
| `notice`  | Who has to be told: `none`, `main`, `captain`, or `urgent` (red).                                    |
| `owner`   | The captain, main, a lane's mate, or a worker with its host.                                         |
| `running` | A turn or a job (named) that runs for the card now, or nothing.                                      |
| `movedAt` | The last real movement: a report, comment, hold, release, answer, or finished job, or `progress_at`. |
| `since`   | How long the state has held. Each state counts from its own evidence.                                |
| `waits`   | The captain, main, a mate, a date (see `datedWait`), a pause, or nothing stated.                     |
| `behind`  | For a held card: how many open steps it names in `remaining`, and how many of them started.          |

A lane's mate reads `behind` with every step in another lane counted as open and not started. The real count would show whether that card is queued, started, or closed, which `remaining` hides on purpose (`elsewhere`). Main and the board see the real count.

`movedAt` never reads `cards.last_activity`, which every reconnect resets. A schedule's wake, a reminder, a restart note, a connect, and a lost job are not movement.

## States

The first row that fits wins.

| State     | A card is in it when                                                                                                   | Counts from                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `you`     | Its status is Needs you, or it is a card of the captain's own.                                                         | The status change          |
| `broken`  | A worker reported `failed`. Or its worker has not been connected for 2 minutes while the card is Working or In review. | The report, or last seen   |
| `stalled` | A worker reported `blocked` or `stopped` 5 minutes ago. Or its running worker has been silent for 5 minutes.           | The report, or last output |
| `running` | A turn or a job runs for it.                                                                                           | `movedAt`                  |
| `waiting` | A dated hold, and the job, schedule, or worker it names runs now. Or the captain's own later, until its date.          | The hold's age             |
| `parked`  | A dated hold that nothing checks (a watcher, an outside date, or an idle park). Or a worker's pause.                   | The hold's age             |
| `idle`    | Nothing runs and nothing says why: a queued card, a card with its mate, an idle worker.                                | `movedAt`                  |

The captain's later is his own choice and his own date, so it is never parked and never an idle park. A hold that says `said` (or a board "later") is `waiting` until its date, however old the hold is, and nobody is asked to act on it: main and the mate see it only in the information list of dated waits, and the captain's status bar does not count it. When its date passes the hold is a decision again, and it counts and shows in the decisions item and in `/d` at once.

A hold ends a worker's report as an attention: `standing` shows `attention` only while a card has no open hold. So a card whose worker reported `blocked`, `stopped`, or `failed` and whose mate then dated it on a running job, schedule, or worker is `waiting` and quiet. When the job, schedule, or worker it names goes, it is an idle park (a dated hold that names nothing is one too), and when the date passes, it is idle. The report stays in the card's history.

## Who is told, and when

| State                | Main is told               | The captain is told | Red          |
| -------------------- | -------------------------- | ------------------- | ------------ |
| `idle`               | after 4 hours              | after 24 hours      |              |
| `parked`             | after 24 hours, then daily | after 24 hours      | after 3 days |
| `stalled`            |                            | at once             |              |
| `broken`             |                            | at once             | at once      |
| `you`                |                            | it is his card      |              |
| `waiting`, `running` | never                      | never               |              |

The limits are `idleMain`, `idleCaptain`, `parked`, and `parkedUrgent` in `timing.ts`, so `CARDD_TIMING_SCALE` scales them with the rest.

Main is told in the 30 minute reminder (see [The timed check](code.md#the-timed-check)). The reminder for neglect goes to main for every lane, and never to the mate that owns the card:

- An idle card past 4 hours is an item to act on, in the first group. It is any card whose state is idle: Queued, Working, In review, With mate, or Merging, finished or not. Its mate keeps the reminders it already had. A card that main already has in its own list, such as a hold with main, is listed once.
- A card parked for over a day is in its own group: start what it waits on, or clear the hold. It rides the daily list: it never starts a 30 minute list, and a 30 minute list for an action carries it only when the daily list is due, so it is not repeated every 30 minutes. It ages from the hold's first opening, so dating the hold again does not restart it. An idle park is listed for action at once, as before.
- A worker's pause past a day is in the same group.

The captain is told by the counts in the status bar of main's pane and by the board's Attention strip.

## Where it shows

- Pi pane: `/pulse` opens an overlay with every open card, quiet first, running cards in one line. See [pane.md](pane.md).
- Pi pane: the counts in the status bar read `pulse` and nothing else. A notice of any kind counts, so an idle card past 4 hours is on main's pane as soon as main is told. `/pulse` names the cards behind the counts. A card that waits on the captain for a decision is counted apart, in the status bar's decisions item, as the same cards that `/d` shows.
- Board: an Attention strip above the lanes, and one line on each card with who has it, what runs, when it moved, what it waits on, and how many steps are behind it. A Needs you card's line says when it moved and how many steps are behind it, so an expired captain hold with work left still shows what is left. The phone's compact rows still hide the line. The board is the captain's, so the strip and the line's alarm show only what the captain is told: a notice of `captain` or `urgent`, or a broken or stalled state. The strip also lists his own cards. An idle card between 4 and 24 hours is main's alone: the board's line for it says what is true and raises no alarm.

Sorting puts the louder notice first, then the state (broken, idle, parked, stalled, you, waiting, running), then the oldest.

## Evidence

`e2e/cardd/pulse.test.ts` reads the pulse of a real `cardd` over each state, with cards aged by writing old times into the scratch database, and reads `behind` as a mate of another lane sees it. `e2e/cardd/neglect.test.ts` reads the reminders, and that the mate that owns a card is not told. `e2e/cardd/pulse.test.ts` also dates blocked and failed cards on a schedule, then removes the schedule and lets a date pass. `e2e/extension/pulse.test.ts` opens `/pulse` in a real Pi pane. `e2e/board/attention.test.ts` reads the strip and the card line in Chromium.
