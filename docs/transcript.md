# Mate transcript

Every fleet mate sets its messages apart in the terminal. Each message has one muted rule above it, so a long conversation reads as separate messages, not one wall of text. The rule names the sender, except for the mate's own replies, which are the default voice and carry no name.

```
── captain ───────────────────────────────────
 What is on the board?

───────────────────────────────────────────
 The board is quiet.

── fleet ─────────────────────────────────────
 [fleet] cleo on c-2 fix-the-scrollbar (hold): Fix the scrollbar?
```

## What it does

- The captain's messages are labelled `captain`.
- A mate's replies have a rule with no name.
- Rows that the fleet delivers (`fleet`, `fleet-link`, `fleet-update`, `fleet-clones`, `fleet-lanes`) are labelled `fleet`. They are drawn as one tinted box without Pi's own `[fleet]` label above the text, because the text already starts with `[fleet]`.
- The rule is one muted color (the theme's `borderMuted`) and fills the width. It is redrawn at every width, so a resize keeps it whole.
- There is one rule for each Pi message, not for each paragraph or text block. A reply with several paragraphs, several text blocks, or thinking before the text has one rule.
- A reply with nothing to show has no rule. That covers an empty reply and a reply that only calls tools. Calm hides short working notes, and a message it empties has no rule either.

- The pane draws the last 500 entries of the session. When the session has more, one muted row above the first drawn entry says how many earlier entries are not drawn, and that the session file and memory keep them. A mate's conversation never compacts, so without the limit a long-lived mate would draw tens of thousands of entries at every frame.
- The limit holds while the mate works. When a run settles and the pane holds more than 1,000 rows, the pane is drawn again from the last 500 entries, and the notice count rises. It waits while the captain is scrolled up in the fullscreen pane, and the next run that settles with the pane following the end does it.
- A tool result is drawn only with its call. If the limit would cut a call from its result, both are left out and the notice counts both.
- The Up arrow still brings back every prompt the captain sent, including the ones above the notice.

Only the screen changes. The session file, the model's context, and `/export` are the same as without it.

## How a home gets it

Like Calm, the repo's `.pi/extensions/fleet.ts` loads `packages/extension/src/transcript/index.ts` in any folder that has `config/lane.json`. Nothing is copied into a home or installed in `~/.pi`. Workers do not load it. An existing mate has it after its next start.

The rule is the fleet repo's own. It does not depend on a dotfiles extension, and a dotfiles extension cannot turn it off.

## Evidence

`e2e/extension/transcript.test.ts` starts a real mate in herdr with the scripted model. It covers a reply that is still pending, a reply of several text blocks with thinking, a silent reply, a resize of the live terminal, a fleet row, and a restart that replays the history. `e2e/extension/history-window.test.ts` starts a mate on a session of 24,000 entries and checks that the notice names the entries left out and that the mate's event loop stays free while it works. It also starts a mate below the limit, works it past 1,000 rows, and checks that the pane is drawn back to the window when the run settles and not while the top is on screen. A third test starts a mate on a session that the limit cuts between a call and its result, and checks the notice count and the Up arrow. Set `TRANSCRIPT_EVIDENCE_DIR` to keep each screen the transcript tests read, as plain text and with colors, and `HISTORY_WINDOW_EVIDENCE_DIR` to keep the top of the pane in the window tests.
