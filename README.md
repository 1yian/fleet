# fleet

Firstmate, rebuilt: cards in one SQLite store (`cardd`), one `fleet` Pi extension per session, and a board.

See [docs/spec.md](docs/spec.md) for the design and [docs/build-plan.md](docs/build-plan.md) for the build order.

Discuss decisions in chat or answer on the board. Main answers your message first, then ends with at most one pending decision and its recommendation, plus `+N more waiting` if there are others. Decisions main hasn't brought up in chat come first, then the one shown least recently. Once main brings one up, it waits for your next chat message before resurfacing a decision. Say `afk` to pause decision reminders in chat until you write again. When you return, main gives you one catch-up in chat.

Ask for a [decision walkthrough](docs/decision-walkthrough.md) to focus on a project or go through the questions in more detail. The [pane](docs/pane.md) shows the board URL, without decision counts or a strip.

Fleet does not provide or manage a browser. Open the board in your own browser.

An open card's **Updates & conversation** leads with the latest report or cleanup summary that is not a reply. Routine progress, task routing, and quiet completed maintenance are folded under **Show technical history**. Blockers, failures, decisions, captain messages, replies, and their parent messages remain visible. Waiting labels name who must act or reply next.
