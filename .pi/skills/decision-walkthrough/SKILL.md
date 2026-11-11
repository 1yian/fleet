---
name: decision-walkthrough
description: Walk the firstmate's pending decisions with the captain one at a time, with evidence and a recommendation. Use when asked to go through decisions, approvals, or open questions together. Resume an active walkthrough after answers, notifications, interruptions, or context reloads.
---

# Decision walkthrough

For mates only. Main talks to the captain. A second mate routes decisions through main and never steers another lane's worker. This skill changes presentation and focus, not authority, safety rules, or the owning mate's job.

## Start or resume

1. Read the live open `board`, then `board(card=N)` for the relevant holds, their threads, and the reports they name. On an unqualified resume or reload without known scope, read the threads of every current captain hold to find the latest walkthrough checkpoint BEFORE selecting a question. The board summary alone does not expose checkpoints in comments. Fetch more entries when needed. Do not infer pending decisions from an old chat list or a report alone.
2. Use the captain's requested scope, or all current captain decisions by default. Main first settles questions already within its authority or escalates the existing hold, not a copy. Leave unrelated and deferred holds alone. Future-dated holds return when due; do not remove their dates to fill the walkthrough.
3. Choose the last offered, still-unanswered question in that scope. Otherwise take urgent safety decisions first, then the oldest unresolved hold, and its first unresolved numbered question. Refresh before presenting or acting: a board answer or another mate may already have settled it.
4. Keep unresolved questions on their existing holds so Needs you stays complete. No separate decision queue, new status, private checklist, or memory-file backlog. A report supplies evidence, not a second source of pending state.

When starting, record a short walkthrough checkpoint with the scope and focused question in the existing focused hold, or with `comment` on an existing captain-only card. Say explicitly that it is presentation context only, not approval or an instruction to resume work. Update it when focus changes, pauses, or ends. Never send a standalone bookkeeping comment to your own worker, even after its hold clears. Do not add decision keys, resolve a key, or withdraw a merge question just to checkpoint. Preserve every unanswered question, option, holder, and date when updating your hold. Never rewrite another lane's hold merely to checkpoint it. Its owning mate can record the context; otherwise use the existing conversation and board thread. If no safe checkpoint location remains, existing answer records establish completion; do not create a card just for presentation state. These hints restore focus, never override live holds or answer records.

A direct start or resume request needs the focused actionable question or truthful no-decisions completion in chat before you yield. Notification actions do not answer it or change its scope.

After compaction, stow, or relaunch, reread this skill, the board, and the focused thread. Reconstruct scope and focus from the latest walkthrough checkpoint and captain messages, then reconcile all answers since it. If scope is missing, say what scope you can recover and ask one clarification, without clearing or duplicating holds.

## Present exactly one decision

Give enough to decide in about 80 words. The full evidence, consequences, and scope stay in the hold's report file, so name its absolute path:

- Name the project and the concrete choice. For a PR, include its full reported HTTPS URL.
- Evidence: the relevant observed facts and their source. Distinguish verified facts, uncertainty, and missing evidence. Read the report, not just its title.
- Consequence: what each realistic option changes, including risk, reversibility, and what waiting blocks.
- Scope: exactly which action, resource, PR, or numbered question the answer would authorize, and what it does not authorize.
- Recommendation: one choice with a reason, and an alternative when useful.
- One clear approval question, such as "Approve this PR's merge once required checks are green?" or "Use the existing account for this deployment only?"

Speak plainly and address the captain per the role contract. Do not dump the decision list or ask permission to continue. A short count of remaining questions is fine only when verified; do not confuse holds with the number of questions. The other decisions stay discoverable on the board. This walkthrough is not approval for scaler IAM changes or any other unrelated permission.

## Answer, record, act, next

Do these in one turn after an approval, rejection, or correction that settles a stale question, including when you delegate background investigation. The final response briefly acknowledges the recorded answer, then presents the next independent unresolved decision with its context and approval question in the SAME response. Never stop at "noted", "I'll do that", or "ready for the next?". Do not wait for asynchronous execution to finish before advancing.

1. Match the answer to the offered question and its exact scope. "Yes" answers that question only. A rejection, request for changes, or explicit deferral also addresses a decision. If ambiguous, ask only the clarification needed and keep the hold. "Later" needs a date or a checkable event; do not invent a date to hide the question.
2. Record the captain's exact words through existing authority tools before acting. In chat, clear a fully answered hold with `hold(card, clear=true, words=...)`; for a merge also give `choice="Approve & merge"` or `"Request changes"`. A board answer already clears its hold: do not clear it twice. Preserve board reply obligations with `replyTo`. Never substitute your own note for the captain's authority.
3. A grouped hold is not blanket approval. For a partial answer, record the exact words and the answered question's scope on the same thread, and rewrite the existing hold to retain every unanswered question and its evidence, recommendation, options, holder, and date. Do not clear the whole hold in chat for a partial answer. A board answer clears the whole hold mechanically: have the owner restore the unanswered remainder immediately, escalating through main as required, before any gated work continues. Options must describe only the remaining questions; never leave a "take all" option that includes an answered question. Keep worker keys open while the grouped captain hold remains: the authority tools refuse a resolving comment through that hold. Once its last question is answered, clear with the captain's exact words, then answer each fully settled key with its recorded scoped decision. If one key covers several questions, it stays open until all are answered. Do not send a partial answer as permission to pass the gate.
4. Route authorized execution through the owner. Check the thread first: do not resend an already-delivered answer or execution instruction merely because an old report replays after reconnect. On main's own card, `comment` its worker with the scoped decision and `resolves=key` only when that key is fully answered. On another lane's card, main comments to its mate, quoting the captain's words and the remaining gate; that mate steers its worker. For an approved merge, clear the merge hold first, then tell the owning worker to merge only with green required checks. Main never merges itself or steers another mate's worker. A local landing uses the existing authorized close path.
5. Re-read the live board and affected threads. Skip answered, withdrawn, moot-with-confirmation, or explicitly deferred questions. Select and present the next unresolved question immediately. New decisions join through normal holds, not a private queue. Do not re-ask the previous question because its operation is still running.

If the captain supplies evidence that an operation already happened, do not ask permission to do it again. Record the correction and evidence on the existing card. A hold on the captain still needs his exact words to clear; his evidence is not blanket approval for unrelated actions. Route any needed read-only reconciliation through the owning mate or worker, then ask the next independent decision in that same response. If the current decision genuinely depends on the investigation, keep it discoverable on its hold and choose an independent one now. If none exists, say what evidence is pending and that no independent decision is ready, rather than inventing a choice or declaring the walkthrough complete.

For example, after evidence that LiveKit rotation is already done: acknowledge the correction, delegate read-only verification of the recorded rotation, then immediately give the next unrelated pending decision with evidence, recommendation, scope, and an approval question. Never end at "I'll reconcile the records" or let that investigation consume the response.

An approved action blocked by CI, credentials, a dependency, or an unavailable worker is execution pending, not a fresh approval. Record the approval's scope and actual blocker on the card, route recovery to the owner, and advance. Existing safety checks still apply. If changed evidence requires genuinely new authority, explain the changed scope and hold that new decision. Approval of one PR never approves another; a walkthrough never enables yolo or creates standing permission.

## Keep focus

- Routine notifications: perform required card actions silently. Do not replace the current question with a status digest or another list. A newly ready PR's approval joins the existing holds: do not announce it, and do not add a second actionable approval question while the current one awaits an answer. If one of the four interruptions needs chat during the walkthrough, keep it brief and finish with the current question and the context needed to answer, not merely "that remains the active decision". Pure no-news wakes still yield; do not repeat the question on every wake. The offered question remains the focus.
- Serious blockers and safety findings: escalate at once under the role contract. State whether they change the current choice. Once handled, return to the still-unresolved question, not the beginning of the walkthrough.
- An unrelated captain request: answer it first, then resume the current question in the same response unless the captain pauses, changes scope, or stops the walkthrough. A notification is not such a request.
- Pause or stop: record that presentation state on the existing focused thread or hold without altering decision authority or hiding holds. Resume only when asked; "afk" is a pause, not permission to clear anything. On return, offer the current decision. Still raise the four interruptions.
- During an active walkthrough, present one decision at a time and never a list. All mandatory safety escalations, replies, and ownership rules remain in force.

## Finish

Refresh the board once more. When no unresolved decision remains in scope, say "All decisions in this walkthrough are addressed." Mention approved-but-blocked execution and explicit deferrals briefly, without asking them again or claiming the operations finished. Mark the walkthrough ended on the existing thread or hold where safe. If the board cannot be read, say completion is unverified and keep the current focus; do not declare an empty queue.
