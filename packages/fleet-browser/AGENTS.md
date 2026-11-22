# fleet-browser

TypeScript on Node 24, built with `tsc` into `dist/`. Check changes with `bun run typecheck` and `bun run lint`. There are no unit tests: behavior is proven end to end against a real lane on the browser host and recorded in the pull request.

- The service runs as its own Unix user and the CDP proxy is the only agent path to Chrome; do not add a route that returns cookies, page values from secret fields, or raw CDP ports.
- Chrome is pinned by version in the config, never launched with automation flags, and never replaced by another browser or a fallback.
- The board page contract lives in `docs/stream-api.md`; change it in the same pull request as the code.
- No code comments; put user-facing explanations in help text or docs.
- Secrets live only in the broker (`src/broker`) and in the page. Nothing that reaches the agent, the service log or a process argument may contain a secret; `docs/credentials.md` lists the rules the CDP proxy and the form engine enforce.
