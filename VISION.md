# Fleet vision

Fleet exists so that a captain can hand work to agents without having to watch their terminals to find out who owes the next move.
It serves the captain and the mates who turn his intent into work with a named owner.
It owns exactly one thing: the card that records the assignment, the decisions that govern it, and the handoff back.

## The experience

The captain should be able to leave and come back, read the card, and know what needs him.
He should not have to reconstruct a session, scroll a transcript, or search several terminals to learn where work stands.
Fleet is judged by that calm: fewer interruptions that matter, not more updates that do not.

## Authority starts with the captain

The captain is the default authority. A mate settles what it has authority to settle and passes up what it does not.
Wider authority is opt-in and never silent. Today the only built-in standing permission is a project's `yolo` flag, which lets its mate merge a green PR without asking.

An answer in chat and an answer on the board settle the same question.
A new comment on the card does not invalidate the answer.
Withdrawing a question and asking it again requires a fresh answer, even when the words match.
A successful check is evidence about the work, not permission to merge it.

## Software enforces mechanics, agents use judgment

Software enforces the mechanics: who owns a card, what a hold waits on, what a close requires, when a timer fires, and which revision a board action may change.
Agents use judgment: what to build, whether the result is good, and what to ask.
A rule that software can check belongs in software, not in a prompt that an agent must remember.

## Restart is a non-event

A restart of `cardd`, a mate, or a worker should not lose a card, a hold, an owed reply, or a scheduled wake.
The record lives in `cardd`, so recovery reads the record instead of anyone's memory.

## A handoff names what happens next

A worker reports to the mate who gave it the work.
A wait names the person who can unblock it or the event that ends it.
A worker finishing its turn is not the same as a mate accepting its result.

A shipping card names the change to land. An investigation can finish with a finding and a decision about what to do with it. An operation can finish with evidence instead of a pull request.
Recording where the evidence lives does not certify its contents.

## Interrupt the person who can act

The first thing a reader sees on a waiting card is who needs to act and why.
Messages that stop work go through at once. An urgent message never waits to fill a batch.
Routine updates reach the mate together, not one by one.
Quiet does not mean forgotten: when a promised event fails to arrive, its owner hears about it.
A timed wait that Fleet is checking does not need another person watching it.
Technical history stays available without standing between the captain and a decision.

## Say what was observed

An unreadable host is not an empty host.
A missing reply from a running job is not evidence that the job is gone.
One host that stops answering does not stop supervision of the others.

## Scope

Fleet coordinates work in other tools. It is not the captain's browser, file explorer, or a replacement for the repository's checks.
A board, terminal, or chat bridge can carry a card's decisions without keeping a second account of what was decided.

Fleet's record does not depend on one model vendor. A card, its holds, and its handoffs live in `cardd`, not in an agent's session.
Today mates and workers run on Pi, in herdr panes.

## The test for a change

A change aligns when it lets the responsible person dispatch, recover, decide, or accept work from the card without reconstructing a session.
A change should be resisted when it treats silence as evidence, substitutes a status label for permission, or makes the captain reconcile conflicting records.

## Direction

These are goals. They are not current behavior.

- Batches that go out sooner when routine updates collect, and wait longer when traffic is light, always within the five-minute limit.
- Scoped grants on a card or a lane, enforced by the tools, in place of standing permission written in prose.
- A check of each review link from the captain's side before Fleet hands it over.

## Operating rules

These settings apply today. They sit outside the vision and may change without it.

- Routine updates to a mate are batched. A batch goes out within five minutes by default, or sooner when an urgent message arrives.
- A review link stays on the private network (the tailnet). A public link is made only when the captain asks for one. A Cloudflare tunnel (`cloudflared`) runs only then, with the Cloudflare Access setup that the [setup guide](docs/setup.md) describes.
- A recovery limit counts only the restarts that actually ran.
- A fix for a false status is tested where a session or the captain sees that status.
