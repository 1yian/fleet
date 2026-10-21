# Calm mode

Calm is a `/calm` toggle in every fleet mate. It hides the operational rows in the mate's transcript and shows a small boat while the mate works. The conversation stays.

## What it does

While calm is on, the mate's screen drops these rows:

- Every tool row, including the card tools and `dispatch`. A tool row with an image stays.
- Every `[fleet] ...` row: reports, questions, comments, and job results that the fleet delivers to the mate.
- Collapsed thinking.
- Short assistant text before a tool call. A block with a newline, or with 240 characters or more, stays.

It keeps the captain's messages and the mate's replies. While a run is active, a two-row boat sails in place of Pi's `Working...` row.

Calm changes only what the screen draws. Every row stays in the model's context, in the session file, and in `/export`. Turning calm off draws every row again, including the rows that arrived while calm was on.

## Turning it on

Calm is off until the first `/calm`. `/calm` flips it. The choice is saved in `<home>/config/calm` (`on` or `off`), so it belongs to one mate home and survives a restart. A home that has no such file is off. If the file cannot be written, calm stays as it was and Pi says so.

## How a home gets it

Every mate home loads calm: the repo's `.pi/extensions/fleet.ts` loads `packages/extension/src/calm/index.ts` next to the fleet extension in any folder that has `config/lane.json`. There is nothing to copy into a home and nothing to install in `~/.pi`. Workers do not load it.

- A new mate home has `/calm` from its first start.
- An existing mate has it after its next start. Restart the mate (`lane(name, "restart")` from main, or `fleet restart <lane>`). `/reload` is not enough, because the running Pi was started without the extension.
- Each host runs its own checkout of this repository, so update the checkout on every host, including `p620`, then restart the mates there.

Fleet mates run on Pi. There is no Claude Code version of calm.

## How it works

Pi has no global transcript filter, so calm patches the render of three Pi components: tool rows, custom messages, and assistant messages. A patch only decides what a row draws. Each patch checks the Pi member it replaces. If a future Pi moves one, calm logs a line and loses only that part.

It publishes its state on the `firstmate:calm-presentation` event, the same one Firstmate's calm uses, so a readable-transcript extension written for Firstmate stays out of its way.

Fleet's rows are custom messages of type `fleet`, not user messages as in Firstmate, and they never wait in Pi's queue listing. Calm hides them at render time, so it needs none of Firstmate's queued-row handling.

## Evidence

`e2e/extension/calm.test.ts` starts a real mate in herdr with the scripted model. Set `CALM_EVIDENCE_DIR` to keep each screen it reads: before calm, after calm, the boat, the conversation, after a restart, and with calm off again.
