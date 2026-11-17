# Main's pane

Decisions are back in chat and on the board, as before the Nov 10 conversation-shape changes. The footer shows the plain board URL. Fleet adds no decision counts, attention strip, clear-state indicator, or neglect overlay. Calm's boat and the existing transcript remain unchanged.

Answer main in ordinary chat. Main records the captain's exact words against the existing hold before acting. For ordinary chat behavior, see the [README](../README.md). The optional [`/decisions` walkthrough](decision-walkthrough.md) is a prompt template and skill, not a pane card.

The board keeps its original inline questions, option buttons, written answers, and three Later presets: In 3 hours, Tomorrow 09:00, and Monday 09:00. There is no typed-date box. Request changes on a fleet-generated merge question opens the written-answer form instead of immediately submitting a choice, including on older single-option holds. This remains true after Later expires or the question is escalated, provided its options and approval meanings stay unchanged. A mate's own merge options still work, and only options named in `approves` authorize merging. Stale answers remain refused.

Later presets use the current validated server date reader and preserve the captain deferral record. Chat can still record a different date from the captain's exact words with `said`. Existing holds, approvals, dates, and card histories are not reset.

The board no longer duplicates decisions in an Attention strip or adds per-card neglect metadata. Dated-wait information remains, including the date and what the hold waits on. Server pulse calculations and reminders remain available to mates.

## Baseline

The feedback arrived at 2026-11-10T20:41:59.228Z. The last main commit before it was `7cbfbe8bf74b3223c3ac4a1e9fe1861527c7ca11`, dated Nov 10 at 14:12:46 -0600. The earlier removal of pane answers restored the later read-only strip, not this original baseline. The strip first landed at 23:31 that day, after the feedback. The neglect overlay and board Attention strip landed Nov 11.

The restoration is selective. It does not reset the repository or data. Later safety fixes, mate-owned merge options and `approves`, dated-hold validation and records, reload diagnostics, and browser retirement are independent of this display rollback and remain intact.

## Verification

`e2e/extension/pane.test.ts` drives a real Pi in an isolated Scratch home and herdr lab. It covers the original footer, absence of the strip and counts, board answers, exact chat-word answers, no `/pulse` overlay, and reload. `decision-walkthrough.test.ts` checks prompt and skill discovery and partial-answer plumbing, not model judgment. `decision-message.test.ts` checks the contract actually delivered to Pi on a merge arrival. Board attention, Later, and kanban tests exercise the original visible interactions in Chromium.

## Maintainer-owned spec follow-up

Keep `docs/spec.md` unchanged in this worktree. The maintainer must update its authoritative working copy and publish it. Sections 7.6, 10.1, 10.4, and 12.5 still promise a Needs you widget and must reflect the restored footer-only Pi display, with decisions in chat and on the board. Section 14 also cites the removed widget count. Do not restore a widget to satisfy these stale references.

PR handoff: include this ownership constraint and all four affected sections (7.6, 10.1, 10.4, and 12.5), plus the section 14 reference, in the PR description. The maintainer-owned publication follow-up does not block the authorized restoration. Preserve unrelated behavior and data.
