# The pane: the status bar, the decision card, and /pulse

Main's Pi screen shows what needs the captain without a message in the chat. The status bar, the last line of the footer, carries it. The pane draws nothing above the editor, and when all is clear the status bar says so.

Only main shows the decisions and the counts. A second mate's status bar has the board link and no decisions or counts, because a second mate holds nothing for the captain.

The chat stays silent about what waits. Main never tells the captain to type `/d` and never points him at the card. The role contract (`packages/extension/prompts/mate.md`, sections 7 and 8) owns when main may speak of a waiting decision: when he asks what waits, and for interruption 4. Neither case carries an instruction.

## What it shows

The status bar is one line. The decisions come first, then the counts, then the board link:

```
2 decisions await you ● 1 ◆ 1 ◇ 1 ▲ 3 board
```

| Item                    | Meaning                                                 | Color                  |
| ----------------------- | ------------------------------------------------------- | ---------------------- |
| `2 decisions await you` | Decisions that wait for the captain, and a click target | yellow                 |
| `● 2`                   | Broken                                                  | red                    |
| `◆ 1`                   | A card of his own, which waits on him                   | yellow                 |
| `◇ 1`                   | Stalled, idle, or parked                                | orange                 |
| `▲ 4`                   | Landed since the captain's last message                 | green                  |
| `✓ clear`               | Nothing is broken, neglected, or waiting for him        | muted                  |
| `board`                 | A link to the board                                     | link color, underlined |

The decisions item reads `1 decision awaits you` when one waits, `N decisions await you` when more do, and is absent when none do. It counts the decisions that `/d` walks through, and it is made from the same code, so the two cannot differ. A click on the item does what typing `/d` does (see [The decision card](#the-decision-card)).

The word `board` is a link to the board. The status bar never shows the address. The target is the address of `cardd` with `http` for `ws`, which is the tailnet or local address that main's lane already uses. In a terminal that has hyperlinks (OSC 8), `board` is a terminal hyperlink. In Pi's fullscreen mode a click on it opens the board, and in the other terminals the terminal's own link click does (often Cmd-click or Ctrl-click). Where the terminal has no hyperlinks, `board` is plain text, and a click on it opens the board from the extension. Both open the link on the machine where Pi runs: `open` on macOS and `xdg-open` elsewhere.

Pi cuts a status bar that is wider than the pane with a dim `...` at the right. The order keeps the decisions on screen the longest. The cache state goes first, then the board link, then the counts. The whole line `2 decisions await you ● 1 ▲ 1 board` needs 35 columns.

## The decision card

`/d` opens the captain's decisions: the holds that wait on him. A click on the decisions item in the status bar opens the same card, by the same code, so the two cannot differ.

The card is inline, the way Pi draws its own selectors. It takes the editor's place, between the chat and the footer, with a rule above and below. The chat stays in view above it. It is not a box that floats over the chat. The status bar stays under it, and its count drops as the captain answers. The editor comes back, with whatever the captain had typed in it, when the card closes. The card shows one decision at a time, the oldest first:

```
── ◆ Decision 1 of 3 ●○○ ──────────────────────────────────────────────

 c-12 Ship the scrollbar fix

 Ship it? I recommend yes: the checks are green.
 Report: /Users/yian/reports/c-12.md

 → Ship it (recommended)
   Hold
   My words…
   Later…

 ↑↓ choose   ←→ decision   ⏎ select   type your own words   esc close
──────────────────────────────────────────────────────────────────────
```

- The text is the hold's question, and the choices are its options, with the first marked as the mate's recommendation. `My words…` and `Later…` are the last two choices, and each is a line to type in. A long question scrolls with PgUp and PgDn. Every decision has both, whatever kind of hold it is: with options, with none, or a merge question.
- The captain's own words never need a step. Typing a letter or pasting text on a choice or on `My words…` moves the pointer to `My words…` and puts the text there. `⏎` on that line answers with his words, and `esc` clears them. A pasted text of several lines becomes one line. Typing never answers with the highlighted choice.
- `Later…` puts the decision off until a time he types: `tomorrow`, `Friday 4PM`, `4PM CST`, `Nov 20`, `in 2 hours`, or his own sentence that holds one. Move the pointer to `Later…` and type, and `⏎` holds the decision until then. The decision leaves his list and returns by itself at that time, and the card moves to the next open decision. A notice says what `cardd` read, with the time and the zone, such as `c-12 comes back to you Thu, Dec 31, 2099, 4:00 PM GMT+9 (Asia/Tokyo)`. The year shows only when it is not this year. A bare time or day is read in the time zone of the machine that runs main's Pi. A zone in his words wins (a name such as `CST` or `UTC`, a city such as `Europe/Paris`, or an offset such as `UTC+2`) and is never replaced by the zone of his screen. `cardd` never guesses. Text that holds no time, such as `after the demo`, or that it cannot read whole, such as an unknown zone, a time that does not exist where the clocks go forward, or `in 2 hours and 30 minutes`, stays on the `Later…` line with the reason and what to say, and nothing is held. The zone names the reader knows and each refusal are in [code.md](code.md#pane). `esc` clears the line. `esc` on a line with no words closes the card.
- `←` and `→` move between the decisions, around the ends, and skip the ones he already answered. They answer nothing. While there are words on the `My words…` or `Later…` line they move the text cursor instead. The dots in the title show the place: `●` is this decision, `○` is one still open, and `✓` is one he answered.
- A click on a choice answers with it, as `⏎` does. A press with no release only moves the pointer to it. A click on `My words…` or `Later…` selects the line and answers nothing.
- The card fits the pane down to 12 rows, in every state. It leaves the footer and two rows of chat. In a short pane it drops its blank rows first, then shows fewer lines of the question and fewer choices, but always at least one choice. The choices scroll with the selection, and the hint shows the place, such as `2/5`, while some are out of sight.
- `⏎` answers the whole hold and the card moves to the next open decision. `esc` closes the card and answers nothing. Typing `/d` again shows the first decision that is still open, so `/d` both starts and resumes.
- Later is the board's own action too: the extension calls the `pane.later` op with the card, the hold entry it showed, his words, and its time zone. `cardd` checks the hold as it does for an answer. It is recorded as the captain's own dated hold, with `said` as his words and `until` as the time `cardd` read from them. No tool of the model reaches it, and only main's session may call the op.
- The answer is the board's own action: the extension calls the `pane.answer` op with the card and the hold entry it showed. `cardd` refuses it only when that hold itself changed since: its question, its options, or who it waits on, or it was answered, released, withdrawn, or put off. A hold that was cleared and then asked again is a new hold, even with the same words. A comment, a report, or any other entry on the card does not refuse it. Otherwise it is recorded as the captain's `answer`, with `source: "pane"`, and his own words are the answer's text with `written: true`. Main gets `[fleet] captain on c-N (answer): <choice or words>`, the same line a board answer sends. Only main's session may call the op.
- After a refusal the card shows the reason, such as `c-12's decision changed`, and reads the decisions again. If the decision still waits, the card shows its new question and options in place and keeps the words he typed, and nothing is sent until he sends them again. The pointer stays on `My words…` or `Later…` if it was there, follows a choice by its label if the reloaded decision still has it, and otherwise goes back to the first choice. If the decision no longer waits, the card moves to the next open one.
- When nothing waits, `/d` says so in a notice and opens nothing.
- The card is drawn by the extension and is never in the model's context. Main learns of an answer only from that `[fleet]` line.
- A click needs Pi's fullscreen mode, the default, which routes the mouse to components. In regular mode the terminal keeps the mouse and only the keys work.

## What counts

Each card has a `pulse` from `cardd` (see [neglect.md](neglect.md)). The pane reads its state and notice and keeps no limit of its own.

| Item     | A card counts when                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision | Its status is Needs you, and the `card` op still shows a hold that waits on the captain. These are the cards `/d` walks through.                                                      |
| Own card | Its pulse state is `you` and its status is not Needs you: a card of the captain's own, with no hold on him and no later of his own. `/d` does not show it.                            |
| Broken   | A worker reported `failed`. Or a worker is not connected for 2 minutes while the card is Working or In review. Or a card has been parked for 3 days with nothing running or checking. |
| Stalled  | A worker reported `blocked` or `stopped` 5 minutes ago, or a running worker has been silent for 5 minutes. Or a card has been idle for 4 hours, or parked for 24 hours.               |

A decision is never also broken, stalled, or an own card, and it is counted once, in the decisions item.

A hold that the captain put off with his own later (`said`, or a board "later") is not a decision until its date, and is not broken, stalled, or parked either, however old the hold is: its pulse is `waiting`. So it is in neither the decisions item nor the counts, and `/d` skips it. At its date it is a decision again, in the item and in `/d` together (see [How it stays current](#how-it-stays-current)).

An idle card counts from 4 hours, when main is told. Only main shows this pane, so main sees it there, and `/pulse` says how long the card has been idle.

A reported need counts its age from the report itself, so a card that its worker already handed back, and that then reports `blocked`, is not stalled until 5 minutes after that report. The limits are `cardd`'s own (`timing.ts`), so `CARDD_TIMING_SCALE` scales them.

When `cardd` has not answered for 30 seconds, the status bar shows `● cardd: not answering` in place of the decisions and the counts, because they are no longer current. They return when `cardd` answers again.

Landed counts the cards that ended Done since the captain's last message. His next message resets it. A message that is a command, such as `/calm`, is not a message. The count survives a reload because it starts from the last user message in the session.

## /pulse

`/pulse` opens an overlay with every open card, quiet first. It is a pull view: it is drawn by `ctx.ui.custom`, so it never enters the chat or the model's context.

```
╭─ Pulse · 36 open · quiet first ────────────────╮
│                                                │
│ ● PARKED 6d  c-1187 cleo                       │
│   crud run.app URL bypasses Cloud Armor        │
│   cleo (mate) · running nothing · moved 6d ago │
│   waits on an outside date: first hub use      │
│   3 steps behind it, none started              │
│                                                │
│ ◆ YOU 4.4d  c-1051 fleet                       │
│   Bitwarden login for the p620 browser         │
│   moved 4.4d ago                               │
│                                                │
│ ▶ 24 running                          ⏎ expand │
│ ↑↓ move   ⏎ board link   esc close             │
╰────────────────────────────────────────────────╯
```

- Rows are sorted by who must be told (red, then amber), then by state (broken, idle, parked, stalled, you, waiting), then oldest first. Running cards are one line. `⏎` on it opens their list, and each running card is then a row of its own: `↓` moves down it, `⏎` on a card shows its board link, and `⏎` on the count closes the list.
- A row shows its state and how long it has held, the card, its lane, and its title. Every row adds when the card last moved and how many steps are behind it, if it has a hold that names some. A row that is not a Needs you row also adds who has it, what runs, and what it waits on. A Needs you row skips those three, because the captain has it.
- `⏎` on a card closes the overlay and shows the card's board link. Where the terminal supports links, the card number is one too.
- It reads the board when it opens. It does not refresh while open.
- A long list scrolls with `↑` and `↓`. `esc` or `q` closes it.

## What it does not do

- It is not in the model's context. The status bar and the card are drawn with `ctx.ui.setStatus` and `ctx.ui.custom`, which are not session messages. Main still learns state from the same `[fleet]` rows and the `board` tool as before.
- It does not name the card behind a broken or stalled count. `/pulse` lists every open card with its state, age, lane, and title, and the board shows them too.
- It replaces nothing: not the editor (OptChat owns it, and the card only stands in its place while it is open), not the footer, and not the terminal title.
- It has no image or animation. The only mouse use is the click on the decisions item, the click on `board`, and, while the card is open, a click on its choices.

## How it stays current

The pane asks `cardd` for the board when the link connects, after every `[fleet]` row, after main's `hold`, `comment`, `close`, or `dispatch`, when the decision card closes, and a minute after its last ask. The minute catches what sends no row, such as a worker that goes quiet. The pane also asks just after the earliest date of any dated hold, so a hold whose date passes is counted the moment it passes, as `/d` shows it, and not up to a minute later. While `cardd` does not answer, it asks every 10 seconds. Each ask also reads the hold of every card that waits for the captain, so the count is the number of decisions `/d` would show at that moment. An answer given in the pane or on the board reaches main as a `[fleet]` row, and that row lowers the count.

## Evidence

`e2e/extension/status-bar.test.ts` starts a real main in herdr against a real `cardd`. It reads the status bar for the word `board` and no address, clicks `board` with and without terminal hyperlinks and reads the address that a stand-in `xdg-open` received, and counts none, one, and several decisions as the captain answers them. It puts a card off with a dated later, a card of the captain's own included, and reads that it is neither counted nor on `/d` however old the hold, and that it returns in both at its date. It reads the status bar at 57, 39, and 33 columns and clicks the decisions item at each. Set `DECIDE_EVIDENCE_DIR` to keep the screens.

`e2e/extension/decision-silence.test.ts` starts a mate on main's lane and on a second mate's lane, reads the role contract that the model receives, and checks that it never names `/d` and keeps chat silent about waiting decisions.

`e2e/extension/decide.test.ts` starts a real main in herdr against a real `cardd`, types `/d`, presses keys, and sends a mouse click to the decisions item. `e2e/extension/decide-later.test.ts` does the same for `Later…`: the typed time that holds the decision in the zone of main's Pi, the text with no time that stays on its line, a zone it does not know that stays on its line while a zone it knows holds with the time it reads, and `My words…` and `Later…` on a decision with options, one with none, and a merge question. `e2e/extension/decide-input.test.ts` does the same for the words he types, the arrow keys, a mouse press and release on the choices, and the editor's text coming back when the card closes. They read the card from the screen and the answers from the board's thread. Set `DECIDE_EVIDENCE_DIR` to keep the screens.

`e2e/extension/pane.test.ts` starts a real main in herdr against a real `cardd` and reads the screen. Set `PANE_EVIDENCE_DIR` to keep each screen it reads: clear, a captain hold, answered, broken and stalled and landed, after his message, and `cardd` down and back. `e2e/extension/pulse.test.ts` types `/pulse` into the same pane and reads the overlay: its order, the collapsed running line, that nothing reaches the model's context, the count and the overlay row of a card idle past 4 hours, a watcher with line breaks, and a list of 40 running cards that scrolls inside the overlay.
