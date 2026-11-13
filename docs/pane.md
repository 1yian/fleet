# Main's pane

The pane shows attention without taking answers. Decisions are answered in chat or on the board. There is no `/d` decision card and no pane answer or Later operation.

The [mate contract](../packages/extension/prompts/mate.md#7-holds) owns how main presents and clears chat decisions. Board answers follow the merge-choice rules below.

## Attention

The footer shows glyph counts: broken `●`, needs you `◆`, stalled `◇`, and landed `▲`. When nothing needs attention it shows `✓ clear`. The needs-you count includes both decisions and the captain's own work cards. Landings count Done cards since the captain's last message, excluding lane and standing cards.

A tinted row above the editor shows the worst need first, with the count of the others. Long titles are cut to one row. It is read-only: no click opens a card or writes an answer. It draws no border.

The board URL appears in full in the footer, without a token. Terminals that support hyperlinks may open it using their normal link behavior. Fleet does not intercept clicks or global URL opening and needs no Element connection.

The pane reads cardd on connection, delivered fleet messages, card-changing tools, and once a minute. After 30 seconds without an answer it shows `cardd: not answering`. It refreshes when cardd returns. Cardd owns the pulse rules, including which dated or tracked waits are covered rather than stalled.

## Pulse

`/pulse` opens the read-only neglect view, quiet cards first. Running cards can be expanded. Arrow keys scroll, Enter shows the selected card's board URL, and Escape closes it. Nothing in this overlay enters the model's context or answers a hold.

## Board decisions

The board retains options, typed answers, merge options with `approves`, and dated Later. A merge question keeps the mate's own options. Only an option named in `approves` approves it. Other choices and typed words reach the mate to judge.

Later accepts the captain's words and time zone, shows the date it read, and puts the decision off until then. Main may also record Later from the captain's exact chat words using `said`. The server refuses stale answers and stale Later actions when the decision itself changed.

## Verification

`e2e/extension/pane.test.ts` drives main through an isolated herdr session. It covers read-only attention, removed decision controls, board answering, chat clearing, reloads, sanitization, and loss of cardd. `pulse.test.ts` covers the neglect overlay. `board-link.test.ts` covers full URL output. Board, holds, Later, merge options, and decision-message suites cover the retained answer paths and contract.
