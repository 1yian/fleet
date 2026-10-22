# OptChat, vendored

Conversation memory for fleet mates. `packages/extension/src/optchat.ts` loads `firstmate/loader.ts` from here when a home has `config/optchat.json`.

## Where it came from

- `src/`, `LICENSE`, `THIRD_PARTY_NOTICES.md`: pi-optchat 0.7.2 by Jonas (MIT), https://github.com/jonaslsaa/pi-optchat, npm integrity `sha512-S3VreOgaLbBIizJfW8lQdOL5pA2p9rS0XnAnJ4tKSOHu+HAeam1PYbptfzFD6EjyXJJsibiMooBFDPsDb8lzfA==`, with the dotfiles patches `connected-windows.patch`, `summary-labels.patch`, and `compactor-fallback.patch` applied (patch set sha256 `b466661ae81fcb0aafa8548ae667c6ee6b4a71d1112d1524abfce561cf0b7bc4`). It was copied from a package that the dotfiles' `package.mjs verifyPackage` accepted.
- `firstmate/loader.ts` and `firstmate/compat.ts`: the dotfiles' `home/.pi/agent/extensions/fm-optchat` at commit `b1abeff` (index.ts and lib/fm-optchat-compat.ts).

## Fleet's changes

- The loader imports the source from this folder instead of a prepared package in each home, and no longer checks a package fingerprint. `config/optchat.json` needs no `package`.
- Without `compactorProvider` and `compactorModel`, summaries go to `tier/compact` when that model exists, not to the mate's own model.
- A run that starts while the last request's prompt cache is still warm keeps the view it was built on and sends the earlier runs raw after it, so the request only appends to the cached prefix. A cold cache (past the model's declared lifetime for the process's retention, or Pi's defaults), or more than 120 KB of raw runs, builds a fresh view. Upstream builds a fresh view every run, and its oldest lines merge as it grows, so each turn rewrote the whole cache after the system prompt: on 2026-10-21 that was most of main's $391.
