# fleet

Firstmate, rebuilt: cards in one SQLite store (`cardd`), one `fleet` Pi extension per session, and a board.

See [docs/spec.md](docs/spec.md) for the design and [docs/build-plan.md](docs/build-plan.md) for the build order.

Discuss decisions in chat or answer on the board. The [pane](docs/pane.md) shows the board URL, without decision counts or a strip.

See [how to deliver one outcome in two PRs](docs/multiple-pr-delivery.md).

Fleet does not provide or manage a browser. Open the board in your own browser. It can show browsers managed by fleet-browser; see [Lane browsers on the board](docs/setup.md#lane-browsers-on-the-board).

An open card's **Updates & conversation** leads with the latest report or cleanup summary that is not a reply. Routine progress, task routing, and quiet completed maintenance are folded under **Show technical history**. Blockers, failures, decisions, captain messages, replies, and their parent messages remain visible. Waiting labels name who must act or reply next.

Main can also talk to one Discord channel. See [the Discord bridge](docs/setup.md#discord-bridge).
