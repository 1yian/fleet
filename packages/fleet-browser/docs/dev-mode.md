# Dev mode

Dev mode is for pages you serve yourself (localhost dev servers, preview builds): a throwaway browser, no sign-ins, no captain.

```
fleet-browser dev open http://localhost:3000        headless Chrome on your own machine, fresh profile
fleet-browser dev snapshot -i | click | fill | eval | network requests | screenshot ...
fleet-browser dev console                           console messages and uncaught page errors, merged
fleet-browser dev set viewport 390 844              then screenshot for the phone layout
fleet-browser dev close                             closes the browser and deletes its profile
fleet-browser dev --name checkout ...               a second, independent dev browser
fleet-browser dev --headful open <url>              fresh headful lane on the browser host, watchable in the board; closing it deletes the lane
```

- Headless dev mode runs agent-browser itself with an empty profile per session. Set `FLEET_BROWSER_DEV_CHROME` to a Chrome or Chromium binary if agent-browser cannot find one. It exits by itself after 15 idle minutes.
- `--headful` uses an ephemeral lane named `dev-<name>`: same Chrome as the web lanes, a board viewer (`watch:` link printed on `open`), and no saved state. Stopping it removes the lane, its profile and its registry slot, and the stream API sends `event: gone` for it. Pages on `localhost` there are the browser host's, not yours.
- `console` is merged in web mode too: agent-browser keeps uncaught exceptions under `errors`, so an agent that only reads `console` misses them. Merged output marks them `[error]`.
- Not covered (dropped with chrome-devtools-axi): Lighthouse audits, heap snapshots, performance insight summaries, CPU and network throttling profiles.
