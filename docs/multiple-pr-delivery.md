# One outcome, two pull requests

Fleet tracks one PR URL and one merge decision per ship card. For an outcome that needs two PRs, use two ship cards. Link them by card number in their task messages and threads. This is a written link, not a dependency field or an automatic continuation.

Do not report a second PR URL on the first card. `report(pr=...)` replaces its stored URL. It does not add another PR or create another approval scope. A verified `merged` report can close that card immediately, stop all its attempts, archive leftover work, and remove its worktrees. An archive preserves work but does not deliver the other PR.

## Independent PRs

1. The owning mate dispatches A with `dispatch(title, name, kind="ship", project, intent, host, task)`. Its task names only PR A's scope and says that PR B will have its own card. Leave the Delivery line out. Dispatch uses the project's delivery mode unless the captain requested an override.
2. Dispatch B with its own name, branch, worker and delivery. In B's task, name `c-A`, the shared outcome, B's scope and any shared-file risks. Comment on A with B's number before A reports done. This comment steers A, so do it before its merge question opens. If another lane owns B, route through that mate instead of steering its worker.
3. Each worker validates its own branch and reports `done` with only its own full PR URL. For no-mistakes, each worker runs its own pipeline and reports its exact-head green result. Read both cards with `board(card=...)`. Do not treat the shared outcome as delivered yet.
4. With yolo off, each card gets its own merge question. Obtain the captain's words for each PR separately. For a chat approval, clear that card's hold with `hold(card, clear=true, words=<exact words>, choice=<approving option>)`. A board answer records this itself. Second mates escalate their merge questions through main. Yolo does not remove the green-check requirement or the special approval for destructive, irreversible or security-sensitive changes.
5. Comment only on the authorized card: merge its named PR once its required checks are green. Its worker merges and reports `merged` with that same full URL. Fleet verifies the URL with the project's GitHub account and closes that card automatically. If automatic closing fails, resolve the reported cause and use `close(card, summary)` on that card only. An absent, unknown or unmerged URL counts as `done`, not verified completion.
6. Read B again after A closes. B must still show its own PR and pending decision or work. A's approval and close do not authorize, close or cancel B. Continue B through its own validation, approval, merge report and verified close. Tell the captain which part landed and which remains open, with both full URLs when known.

## Dependent continuation

If B depends on A landing, dispatch B after A's verified merge and clone refresh, not from A's unmerged branch. Put A's closed card number and full merged URL in B's task. B starts on the project's base and follows the same independent delivery and approval steps above. A's closed thread can identify the planned continuation; B's task supplies the backlink once B exists. Fleet does not dispatch the continuation automatically.

Do not park independent work behind A's merge. Dispatch independent parts at once. A request to build both parts authorizes the dispatches, not the merges.

## A split discovered after work started

Keep the original card and branch for A. The worker reports the split to its mate with a `working` report, or `blocked` if it cannot safely continue. Workers never dispatch another worker or make another worktree.

Before A can merge or close, commit every wanted change and identify which commits belong to B. Dispatch B with A's card number, branch, exact commit IDs and file scope. B's worker transfers the wanted commits into B's own isolated copy with Git, then verifies the committed result there. Each worker writes only in its own copy. Neither worker removes or prunes worktrees. If changes cannot be transferred without losing A's or B's work, keep A open and ask the owning mate to resolve the split.

After B acknowledges that its branch contains the complete continuation, A's worker removes B-only changes from A's delivered diff and revalidates A. Do not rewrite a branch while its no-mistakes run is active. Follow the pipeline's supported custody procedure first. Already opened PRs must each end up with their own owning card and recorded task branch; do not relabel an unrelated branch as the new card's PR. If that cannot be done through the normal delivery path, keep the original card open and resolve the handoff before merging anything.

Never rely on A's close archive as B's active workspace. Do not use `confirm=true` to declare unfinished work delivered, or `landed=false` to hide a wanted continuation. If B is deliberately abandoned, record that decision on B, clear its hold with the required authority, and use `close(card=B, summary=<why>, landed=false)`. Fleet archives its unlanded work and marks B Dropped, not Done.

## Evidence

`e2e/extension/multiple-pr-delivery.test.ts` drives real isolated Pi, cardd, Git worktrees and herdr through this journey. GitHub is a controlled external fixture. It checks separate merge questions, A's verified automatic close while B remains pending, preservation of B's commit and untracked work, refusal to close B prematurely, and B's later independent merge and close.
