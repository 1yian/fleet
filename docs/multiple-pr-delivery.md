# One outcome, two pull requests

Fleet tracks one PR URL per ship card. For an outcome that needs two PRs, use two ship cards so each PR has its own validation, merge authority and close. Link the cards by number in their tasks and threads. This is a written link, not a dependency field or an automatic continuation.

Do not report a second PR URL on the first card. `report(pr=...)` replaces its stored URL. It does not add another PR or create another approval scope. Before reporting a merge, make sure the other PR's work is on its own card. An archive preserves work but does not deliver the other PR.

## Independent PRs

1. The owning mate dispatches A with `dispatch(title, name, kind="ship", project, intent, host, task)`. Its task names only PR A's scope and says that PR B will have its own card. Leave the Delivery line out. Dispatch uses the project's delivery mode unless the captain requested an override. Both cards need a PR-backed mode (`direct-PR` or `no-mistakes`), not `local-only`.
2. Dispatch B with its own name and worker. B's worker names its own task branch. In B's task, include A's card number, the shared outcome, B's scope and any shared-file risks. If A is still working, comment on A with B's number. This comment steers A and withdraws an open merge question, so if A has already reported done, leave the link on B rather than steering A just to add a backlink. If another lane owns B, route through that mate instead of steering its worker.
3. Each worker validates its own branch and reports `done` with only its own full HTTPS PR URL. Without a recorded PR URL, `done` does not open a PR merge question. For no-mistakes, each worker runs its own pipeline and reports its exact-head green result. Read both cards with `board(card=...)`. Do not treat the shared outcome as delivered yet.
4. With yolo off, each card gets its own merge question. Obtain the captain's words for each PR separately. For a chat approval, clear that card's hold with `hold(card, clear=true, words=<exact words>, choice=<approving option>)`. A board answer records this itself. Second mates escalate their merge questions through main. Yolo does not remove the green-check requirement or the special approval for destructive, irreversible or security-sensitive changes.
5. Comment only on the authorized card: merge its named PR once its required checks are green. Its worker merges and calls `report(status="merged", text=<summary>, pr=<same full URL>)`. Fleet verifies the merge and attempts to close that card automatically, stopping its attempts, archiving leftovers and removing its worktrees. If automatic closing fails, resolve the reported cause and use `close(card, summary)` on that card only. An absent, unknown or unmerged URL counts as `done`, not verified completion.
6. Read B again after A closes. Confirm B is still open, with its pending work or decision and its own PR URL if already reported. A's approval and close do not authorize, close or cancel B. Continue B through its own validation, approval, merge report and verified close. Tell the captain which part landed and which remains open, with both full URLs when known.

## Dependent continuation

If B depends on A landing, dispatch B after A's verified merge and clone refresh, not from A's unmerged branch. Put A's closed card number and full merged URL in B's task. B starts on the project's base and follows the same independent delivery and approval steps above. A's closed thread can identify the planned continuation; B's task supplies the backlink once B exists. Fleet does not dispatch the continuation automatically.

Do not park independent work behind A's merge. Dispatch independent parts at once. A request to build both parts authorizes the dispatches, not the merges.

## A split discovered after work started

Keep the original card and branch for A. The worker reports the split to its mate with a `working` report, or `blocked` if it cannot safely continue. Workers never dispatch another worker or make another worktree.

Before A can merge or close, commit every wanted change and identify which commits belong to B. Dispatch B with A's card number, branch, exact commit IDs and file scope. B's worker transfers the wanted commits into B's own isolated copy with Git, then verifies the committed result there. Each worker writes only in its own copy. Neither worker removes or prunes worktrees. If changes cannot be transferred without losing A's or B's work, keep A open and ask the owning mate to resolve the split.

After B acknowledges that its branch contains the complete continuation, A's worker removes B-only changes from A's delivered diff and revalidates A. Do not rewrite a branch while its no-mistakes run is active. Follow the pipeline's supported custody procedure first. Already opened PRs must each end up with their own owning card and recorded task branch; do not relabel an unrelated branch as the new card's PR. If that cannot be done through the normal delivery path, keep the original card open and resolve the handoff before merging anything.

Never rely on A's close archive as B's active workspace. Do not use `confirm=true` to declare unfinished work delivered, or `landed=false` to hide a wanted continuation. If B is deliberately abandoned, record that decision on B, clear its hold with the required authority, and use `close(card=B, summary=<why>, landed=false)`. Fleet archives its unlanded work and marks B Dropped, not Done.

## Evidence

[`e2e/extension/multiple-pr-delivery.test.ts`](../e2e/extension/multiple-pr-delivery.test.ts) covers the independent-card path using isolated Pi, cardd, Git worktrees and herdr. The model turns are scripted, the workers report green checks, and a GitHub fixture supplies PR state and merge results. The test does not run live CI or a no-mistakes pipeline. It checks separate merge questions, A's verified automatic close while B remains pending, preservation of B's commit and untracked work, refusal to close B prematurely, and B's later independent merge and close.
