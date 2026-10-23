# Persistent wakes

`cardd` polls every 15 seconds. Thresholds share `CARDD_TIMING_SCALE` for isolated end-to-end tests. No reminder queries GitHub.

| Obligation                                                                                    | First reminder                                         | Repeats                                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Worker never connected or disconnected                                                        | Mate after 2 minutes                                   | Every 5 minutes                                                                                              |
| Worker has no output or tool activity                                                         | Mate after 5 minutes                                   | Every 5 minutes                                                                                              |
| One running turn has no report, commit, or file change                                        | Mate after 1 hour                                      | Every 5 minutes                                                                                              |
| Worker idle without a handoff                                                                 | Worker after 2 minutes; mate 5 minutes after the nudge | Mate every 5 minutes                                                                                         |
| Runtime failure or failed compaction                                                          | Existing incident notice                               | Mate every 5 minutes until recovery                                                                          |
| Finished open card                                                                            | Owning mate after 2 hours                              | Every 2 hours                                                                                                |
| Cards waiting on a mate: with-mate, merging, holds on it, and for main every captain decision | Each mate, one bundled list, after 30 minutes          | Every 30 minutes; none when empty; a dated hold keeps a card off the list; an expired hold is announced once |
| Unread message                                                                                | Resend after 2 minutes while the receiver is up        | Every 2 minutes; main after 3 resends, then every 15 minutes                                                 |
| Reply owed                                                                                    | Resend after 2 minutes                                 | Every 5 minutes until answered or withdrawn                                                                  |
| Lost long job                                                                                 | Existing lost-job notice after 3 missed heartbeats     | Mate every 5 minutes until rerun or dropped                                                                  |

Output and tool updates refresh activity. After tools finish, Git HEAD and the timestamps and sizes of changed or untracked files refresh productive progress when they actually change. Shell edits and commits with Git options count too. A running tool that emits output is not stalled. Output alone does not prevent spinning.

Each reminder uses the obligation, occurrence, and due tier as its identity. A down mate receives no new reminders. On return it receives the current tier, not a backlog of missed tiers. Closing or completion ends the obligation. A dated hold removes its card from the bundle until the date. Progress reports do not resolve unanswered replies. Scheduled wakes continue while replies remain open.

Runtime failure recovery still uses `recover`. Repeating a notice never retries a model or restarts a process automatically. No programmed escalation substitutes for a healthy second mate deciding when to ask main.

## Explicit PR reports

A worker reports `pr="https://github.com/owner/repo/pull/N"` when done. After an authorized merge succeeds, it reports the same URL and `merged=true`. Fleet stores those reports and close trusts them. It does not discover a PR, watch checks, or confirm a merge with GitHub.

The worker still checks required CI before merging. Captain approval remains required unless yolo authorizes the merge. A report never grants merge authority. Local-only landing still uses the local branch checks.

`docs/spec.md` needs its timed-check, PR discovery, merge confirmation, and escalation descriptions updated by its maintainer to match this plan.
