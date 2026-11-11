# Decision walkthrough

In a firstmate home, ask "Walk me through the pending decisions one by one" or run:

```text
/decisions
```

Add a project or topic to limit the scope, or use `/decisions resume`. The `.pi/prompts/decisions.md` template exposes this command. The skill also supports Pi's `/skill:decision-walkthrough` command and lives in `.pi/skills/decision-walkthrough/SKILL.md`, which Pi discovers in main's home and the second mates' worktree homes. It needs no new runtime service or configuration. For another Pi installation, copy that skill directory to a configured skills directory and use `/skill:decision-walkthrough`. The `/decisions` alias is the home template above. The skill still requires the fleet mate tools and role contract.

The mate reads the live board and existing holds. It presents one choice with evidence, consequences, scope, a recommendation, and an approval question, in about 80 words. The full evidence stays in the hold's report file. Answer in chat or on the board. The mate records the answer using the existing authority path, routes work through its owner, and presents the next choice in the same reply. It does not wait for an approved operation to finish.

A correction counts too: if the captain shows that LiveKit rotation is already done, the mate records the evidence, delegates any read-only reconciliation, and asks the next independent decision in that same response. The background investigation is not a reason to stop at acknowledgment or re-ask for rotation approval.

A partial answer to a grouped hold settles only that question. The remaining questions stay on the same hold. The worker cannot pass the gate until all its questions are answered. Board answers mechanically release a whole hold, so the owner restores any unanswered remainder before work continues.

Routine notifications do not change the focus. An unrelated request gets an answer before the walkthrough resumes. Say "pause", "afk", or "stop" to suspend presentation, then ask to resume. Holds stay discoverable. Focus and scope are recovered from the existing hold or thread and the captain's messages after a context reload; no second decision queue is stored.

Each PR still needs its own merge authority and green required checks. A recorded approval blocked on CI or another dependency is pending execution, not another unanswered approval. Main routes another lane's action to its mate, never directly to its worker. This workflow grants no unrelated permission.

The walkthrough ends when every decision in scope has an answer, including explicit deferrals. It does not claim that approved operations have finished. Unrelated holds stay untouched.

## Validation

`e2e/extension/decision-walkthrough.test.ts` runs a real Pi in an isolated `Scratch` home against a real `cardd`. It checks skill-command discovery and the public board after a scripted partial-answer tool sequence. This verifies discovery and tool plumbing, not model judgment.

Evaluate model judgment separately in development, using an isolated `Scratch` home and real Pi and `cardd` sessions. Keep transcripts, tool results, and board snapshots outside the repository. Cover answer-plus-next, routine notifications, an unrelated interruption, grouped partial answers, approved-but-blocked execution, context reload, and completion with unrelated holds intact. Do not add live-model calls to CI or claim that scripted model prose proves the skill's instructions work.
