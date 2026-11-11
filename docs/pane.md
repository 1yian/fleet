# The pane: counts, a strip, and the decision card

Main's Pi screen shows what needs the captain without a message in the chat. Colored counts sit in the status line. One tinted row sits above the editor, and only while something needs attention. When all is clear the pane has no extra row.

Only main shows it. A second mate's screen does not, because a second mate holds nothing for the captain.

## What it shows

The status line carries the counts, worst first:

| Count     | Meaning                                     | Color  |
| --------- | ------------------------------------------- | ------ |
| `● 2`     | Broken                                      | red    |
| `◆ 3`     | Needs you                                   | yellow |
| `◇ 1`     | Stalled                                     | orange |
| `▲ 4`     | Landed since the captain's last message     | green  |
| `✓ clear` | Nothing is broken, held for him, or stalled | muted  |

The strip is one row above the editor, tinted with the color of its worst need. It starts with `●`, `◆`, or `◇`, names the card and why, and shows `+N more` at the right when there is more than one need:

```
 ◆ c-12 Ship the scrollbar fix: needs you (2h)                      +1 more · /d
```

`/d` stands at the right end whenever a decision waits for the captain. Clicking the strip does what typing `/d` does (see [The decision card](#the-decision-card)).

The strip shows the worst need: broken first, then needs you, then stalled, oldest first within a kind. It draws no rule and no box, and it never starts with a prompt glyph, so a tool that reads the pane's rows still finds the editor's prompt.

## The decision card

`/d` opens the captain's decisions: the holds that wait on him. A click on the strip opens the same card, by the same code, so the two cannot differ.

The card is inline, the way Pi draws its own selectors. It takes the editor's place, between the chat and the footer, with a rule above and below. The chat stays in view above it. It is not a box that floats over the chat. The strip steps aside while the card is open, and the editor comes back, with whatever the captain had typed in it, when the card closes. The card shows one decision at a time, the oldest first:

```
── ◆ Decision 1 of 3 ●○○ ──────────────────────────────────────────────

 c-12 Ship the scrollbar fix

 Ship it? I recommend yes: the checks are green.
 Report: /Users/yian/reports/c-12.md

 → Ship it (recommended)
   Hold
   My words…

 ↑↓ choose   ←→ decision   ⏎ select   type your own words   esc later
──────────────────────────────────────────────────────────────────────
```

- The text is the hold's question, and the choices are its options, with the first marked as the mate's recommendation. `My words…` is the last choice, and it is a line to type in. A long question scrolls with PgUp and PgDn, or with the wheel over the card.
- The captain's own words never need a step. Typing a letter or pasting text anywhere on the card moves the pointer to `My words…` and puts the text there. `⏎` on that line answers with his words, and `esc` clears them. A pasted text of several lines becomes one line. Typing never answers with the highlighted choice.
- `←` and `→` move between the decisions, around the ends, and skip the ones he already answered. They answer nothing. While there are words on the `My words…` line they move the text cursor instead. The dots in the title show the place: `●` is this decision, `○` is one still open, and `✓` is one he answered.
- A click on a choice answers with it, as `⏎` does. A press with no release only moves the pointer to it. A click on `My words…` selects the line and answers nothing.
- The card fits the pane down to 12 rows, in every state. It leaves the footer and two rows of chat. In a short pane it drops its blank rows first, then shows fewer lines of the question and fewer choices, but always at least one choice. The choices scroll with the selection, and the hint shows the place, such as `2/5`, while some are out of sight.
- `⏎` answers the whole hold and the card moves to the next open decision. `esc` closes the card and answers nothing. Typing `/d` again shows the first decision that is still open, so `/d` both starts and resumes.
- The answer is the board's own action: the extension calls the `pane.answer` op with the card and the revision it showed. `cardd` refuses it when the card changed since. The card then shows the reason and reads the decisions again. If the decision still waits, the card stays on it and keeps the words he typed. Otherwise it is recorded as the captain's `answer`, with `source: "pane"`, and his own words are the answer's text with `written: true`. Main gets `[fleet] captain on c-N (answer): <choice or words>`, the same line a board answer sends. Only main's session may call the op.
- When nothing waits, `/d` says so in a notice and opens nothing.
- The card is drawn by the extension and is never in the model's context. Main learns of an answer only from that `[fleet]` line.
- A click needs Pi's fullscreen mode, the default, which routes the mouse to components. In regular mode the terminal keeps the mouse and only the keys work.

## What counts

| Need      | A card counts when                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs you | Its status is Needs you: a hold waits on the captain.                                                                                                             |
| Broken    | A worker reported `failed`. Or a worker's session is not connected for 2 minutes (never connected, exited, or lost) while the card is Working or In review.       |
| Stalled   | A running worker has been silent for 5 minutes. Or a worker reported `blocked` or `stopped`, and 5 minutes have passed since that report with no one resuming it. |

A reported need counts its age from the report itself, not from the last change of the card's status. A card that its worker already handed back, and that then reports `blocked`, is not stalled until 5 minutes after that report. [code.md](code.md) says how the pane reads that time.

The two times are `cardd`'s own: `notConnected` and `stall` in the timed check. A reload or a brief disconnect is under both, so it does not flicker.

When `cardd` has not answered for 30 seconds, the pane shows that alone as a broken need (`● cardd: not answering`), because every other count is no longer current. The counts return when `cardd` answers again.

Landed counts the cards that ended Done since the captain's last message. His next message resets it. A message that is a command, such as `/calm`, is not a message. The count survives a reload because it starts from the last user message in the session.

## What it does not do

- It is not in the model's context. The counts, the strip, and the card are drawn with `ctx.ui.setStatus`, `ctx.ui.setWidget`, and `ctx.ui.custom`, which are not session messages. Main still learns state from the same `[fleet]` rows and the `board` tool as before.
- It replaces nothing: not the editor (OptChat owns it), not the footer, and not the terminal title.
- It has no image or animation. The only mouse use is the click on the strip and, while the card is open, a click or the wheel on the card.

## How it stays current

The pane asks `cardd` for the board when the link connects, after every `[fleet]` row, after main's `hold`, `comment`, `close`, or `dispatch`, when the decision card closes, and a minute after its last ask. The minute catches what sends no row: a worker that goes quiet, or a hold whose date passes. While `cardd` does not answer, it asks every 10 seconds.

## Evidence

`e2e/extension/decide.test.ts` starts a real main in herdr against a real `cardd`, types `/d`, presses keys, types words, and sends mouse presses and releases to the strip and to the choices. It reads the card from the screen and the answers from the board's thread. Set `DECIDE_EVIDENCE_DIR` to keep the screens.

`e2e/extension/pane.test.ts` starts a real main in herdr against a real `cardd` and reads the screen. Set `PANE_EVIDENCE_DIR` to keep each screen it reads: clear, a captain hold, answered, broken and stalled and landed, after his message, and `cardd` down and back.
