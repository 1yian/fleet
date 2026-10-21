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

Only the screen changes. The session file, the model's context, and `/export` are the same as without it.

## How a home gets it

Like Calm, the repo's `.pi/extensions/fleet.ts` loads `packages/extension/src/transcript/index.ts` in any folder that has `config/lane.json`. Nothing is copied into a home or installed in `~/.pi`. Workers do not load it. An existing mate has it after its next start.

The rule is the fleet repo's own. It does not depend on a dotfiles extension, and a dotfiles extension cannot turn it off.

## Evidence

`e2e/extension/transcript.test.ts` starts a real mate in herdr with the scripted model. It covers a reply that is still pending, a reply of several text blocks with thinking, a silent reply, a resize of the live terminal, a fleet row, and a restart that replays the history. Set `TRANSCRIPT_EVIDENCE_DIR` to keep each screen it reads, as plain text and with colors.
