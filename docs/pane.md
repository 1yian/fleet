# The pane: counts and a strip

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

The strip is one row above the editor, tinted with the color of its worst need. It starts with `●`, `◆`, or `◇`, names the card and why, and ends with `+N more` when there is more than one need:

```
 ◆ c-12 Ship the scrollbar fix: needs you (2h)
```

The strip shows the worst need: broken first, then needs you, then stalled, oldest first within a kind. It draws no rule and no box, and it never starts with a prompt glyph, so a tool that reads the pane's rows still finds the editor's prompt.

## What counts

| Need      | A card counts when                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs you | Its status is Needs you: a hold waits on the captain.                                                                                                       |
| Broken    | A worker reported `failed`. Or a worker's session is not connected for 2 minutes (never connected, exited, or lost) while the card is Working or In review. |
| Stalled   | A running worker has been silent for 5 minutes. Or a worker reported `blocked` or `stopped`, and 5 minutes have passed with no one resuming it.             |

The two times are `cardd`'s own: `notConnected` and `stall` in the timed check. A reload or a brief disconnect is under both, so it does not flicker.

When `cardd` has not answered for 30 seconds, the pane shows that alone as a broken need (`● cardd: not answering`), because every other count is no longer current. The counts return when `cardd` answers again.

Landed counts the cards that ended Done since the captain's last message. His next message resets it. A message that is a command, such as `/calm`, is not a message. The count survives a reload because it starts from the last user message in the session.

## What it does not do

- It is not in the model's context. The counts and the strip are drawn with `ctx.ui.setStatus` and `ctx.ui.setWidget`, which are not session messages. Main still learns state from the same `[fleet]` rows and the `board` tool as before.
- It replaces nothing: not the editor (OptChat owns it), not the footer, and not the terminal title.
- It has no image, animation, or mouse.

## How it stays current

The pane asks `cardd` for the board when the link connects, after every `[fleet]` row, after main's `hold`, `comment`, `close`, or `dispatch`, and a minute after its last ask. The minute catches what sends no row: a worker that goes quiet, or a hold whose date passes. While `cardd` does not answer, it asks every 10 seconds.

## Evidence

`e2e/extension/pane.test.ts` starts a real main in herdr against a real `cardd` and reads the screen. Set `PANE_EVIDENCE_DIR` to keep each screen it reads: clear, a captain hold, answered, broken and stalled and landed, after his message, and `cardd` down and back.
