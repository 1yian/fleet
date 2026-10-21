[stow] The captain typed /stow. Stow this conversation now. When your turn ends, the fleet reloads your instructions in this same conversation.

Stowing moves what only this conversation knows onto disk, so the next session starts from a compact, current map and not from a journal. It does three things: it curates your memory files, it routes durable knowledge to its owner, and it makes the open work you are holding a record on the board.

## 1. Curate the memory files

The report at the end of this message lists each memory file in your home, entry by entry. The fleet loads all three into your role contract on every turn. Each entry is one bullet line.

- `data/captain.md`: the captain's preferences for this lane's domain, and his working style. Entries do not age.
- `data/captain-shared.md`: preferences that hold across every lane. Main owns it. In a second mate's home it is main's read-only copy: never edit it, and never copy it back.
- `data/learnings.md`: operating facts of this home only. Entries age. It is never shared with another home.

Read each editable file in full before you write it. Then classify every finding against what is already there: new, a duplicate, a replacement of an older entry, or proof that an entry is obsolete.

- Prefer a one-sentence rewrite of an entry over a second entry that says nearly the same.
- A fact that has a stronger owner, such as a document, a config file, or the code, becomes a one-line pointer to it.
- Never file a credential or a secret.
- Write each file with one write that holds the whole new text. Do not append blindly.

Entries in `data/learnings.md` carry a trailing marker that dates them. A marker is an HTML comment at the end of the line:

- `<!--a:YYYY-MM-DD-->` marks an aging entry, with the date it was last confirmed. It is stale 30 days after that date.
- `<!--p:YYYY-MM-DD-->` marks a perishable entry. Its text must name a checkable condition that ends it, such as a card or a version. It is stale 7 days after its date. An entry that names no such condition is aging.
- `<!--P-->` marks an entry that never ages, in a file whose entries would otherwise age.
- `<!--g-->` marks an entry that had no marker. It gets one pass of grace and no date.

`data/captain.md` and `data/captain-shared.md` hold unmarked entries that never age. Mark an entry only when it deviates.

The report flags each entry with its status. Apply these rules to every editable file, not only the one a finding belongs to:

- Refresh an entry's date to today only when this conversation used, confirmed, or re-derived it, and you can name the evidence. Being in the file is not evidence.
- A STALE entry is either re-confirmed with fresh evidence, which refreshes its date, or archived. A stale perishable entry whose condition still holds is re-confirmed. One whose condition is resolved is archived.
- An unmarked entry in `data/learnings.md` that you can confirm gets today's `a` marker. One you cannot confirm gets `<!--g-->`. An entry that already has `<!--g-->` is confirmed with a dated marker, or archived with the note `legacy-unvalidated`.
- Every entry you add gets today's date and its marker.
- Archive a stale or superseded entry by moving it to `data/memory-archive.md`. That file is never loaded. Add a dated heading for this pass, and for each entry its source file, its tier, its last date, and why it left. Never plainly delete a fact that is unique and current.

## 2. Route durable knowledge

Sweep this conversation for knowledge that exists only here: a preference the captain stated in passing, an operating fact or a gotcha, a decision that should outlive the session, and a next step nobody has recorded. Give each finding to its most specific owner:

- The captain's preferences for this lane's domain go in `data/captain.md`.
- A preference that holds across lanes goes in main's `data/captain-shared.md`. As main, edit it, and keep a first line that says it is main-authoritative and read-only in second mates' homes. As a second mate, never edit your copy: `comment(lane=<your lane>, text)` main with the preference in the captain's words.
- An operating fact of this home goes in `data/learnings.md`.
- A note about one card belongs on that card: `comment` on it. An investigation finding belongs in a report file under `data/reports/`.
- Knowledge that nearly every contributor to one project needs belongs in that project's committed `AGENTS.md`. Never write it yourself: only a human adds to it. Tell the captain in your receipt.
- Knowledge that every user of the fleet needs belongs in this repository's tracked files. Do not write it here: it ships through a ship card, and the captain merges it.

Keep the fleet's delivery posture and the captain's private strategy out of project memory.

## 3. Persist the open work you are holding

A reset loses what only this conversation holds, and that includes work that is under way. Make sure the important open work you are holding is on the board: file what was never filed, and correct what you now know is wrong.

- Read the board first. Never file a second card for work that has one.
- Work nobody has started and that is yours to do gets a card: `card_new`. Work that belongs in a second mate's lane goes to that mate with `comment` (main only).
- News for an existing card goes on that card: `comment`, or `hold` when the next step is a question for the captain or for main.
- Do not write open work into a memory file.
- This covers only the open work this conversation holds. It is not a check of the board against GitHub, and you never report it as one. Where the right correction is a judgment you cannot make, leave the record alone and say what it waits on.

## 4. Receipt

Finish with a plain-language receipt for the captain:

- For each of the three memory files, one action: `unchanged`, `added`, `rewritten`, `pruned`, `archived`, or `routed`.
- Each finding you filed somewhere else, and where.
- Each entry you archived, and why.
- Each card you filed or corrected, and each record you left alone with the judgment it waits on.
- What you could not capture, and why.
- Whether the conversation is safe to reset. It is safe when every finding is on disk or on the board, and nothing this conversation knew is lost. Never say it is safe while something is uncaptured. It does not mean that the records are correct: you checked only what this conversation named.

When you have written the receipt, stop. The fleet reloads your instructions and role contract next.
