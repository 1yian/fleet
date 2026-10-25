# OptChat, vendored

Conversation memory for fleet mates. `packages/extension/src/optchat.ts` loads `firstmate/loader.ts` from here when a home has `config/optchat.json`.

## Where it came from

- `src/`, `LICENSE`, `THIRD_PARTY_NOTICES.md`: pi-optchat 0.9.0 by Jonas (MIT), https://github.com/jonaslsaa/pi-optchat, npm integrity `sha512-jm3D3QJoydZNq7WCElPu/Kz4/tDRUWczmXjqZ4k+fwaEPtDpQR+Ni1JCbalB6aTx5nlGnxBHJThuAFn4922A0w==`, with the three dotfiles patches (`connected-windows`, `summary-labels`, `compactor-fallback`) reapplied by hand on 0.9.0 and one fleet patch (`router-aware cache marks`). They are described under "Fleet's changes".
- `firstmate/loader.ts` and `firstmate/compat.ts`: the dotfiles' `home/.pi/agent/extensions/fm-optchat` at commit `b1abeff` (index.ts and lib/fm-optchat-compat.ts).

## Fleet's changes

- The loader imports the source from this folder instead of a prepared package in each home, and no longer checks a package fingerprint. `config/optchat.json` needs no `package`.
- `IMPORT_GUIDANCE` now comes from `src/prompts.ts`, where 0.9.0 moved it.
- `viewBudget` in `config/optchat.json` (bytes, 16000 to 128000) sets the memory view budget, which is the `VIEW` constant (128000) when absent. The loader passes it to `optchat()`, which passes it to `Memory.open`.
- Without `compactorProvider` and `compactorModel`, summaries go to `tier/compact` when that model exists, not to the mate's own model.

## Patches on upstream

Upstream 0.9.0 moved or rewrote the code that three of the four patches touch, so each was reapplied by hand, not with `patch`. The earlier reuse-view patch (reusing the previous memory view between close turns) is not carried.

- Connected windows off (`connectedWindows: false` in `OptChatCapabilities`): no window socket, no pending-report journal, no handoff recovery, and no recovery of the run history. Custom messages whose type is in `transientCustomTypes` reach the model but are never journaled as memory.
- Summary labels: a user-role message that starts with `FIRSTMATE_OP`, `[fleet]`, or `[firstmate] Operational notification` is a `notification`, not the user's words. The label shows in `zoom`, in the memory tree, and in the inspector. Each compaction of a message tells the summary model who can have spoken in it (`provenance` in `prompts.ts`), and the summary prompts name the `notification` kind.
- Compactor fallbacks: a summary call that fails with a rate limit (HTTP 429, "overloaded", "too many requests") moves to the next model of `compactorFallbacks` in the profile's `config.json`, or to `DEFAULT_COMPACTOR_FALLBACKS`, skipping models that are not registered or have no auth. The failing model is not retried first. A length correction stays on the fallback that answered.
- Router-aware cache marks (new in fleet, not in the dotfiles): upstream applies its cache marks only when `ctx.model.api` is `anthropic-messages`. A router such as pi-tiers is a Pi virtual model whose api is `pi-virtual`, so the marks never applied to a mate. `anthropicRequest` in `src/cache.ts` also accepts a `pi-virtual` model when the payload has the shape of an Anthropic request. `src/index.ts` and `src/agents.ts` use it.
