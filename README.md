# porthole

Agent browser service. One real, version-pinned Google Chrome per lane, headful on a virtual display, launched and supervised by a daemon. Agents attach over CDP through the daemon (agent-browser is the only harness), the captain watches and takes over through a web viewer, and secrets are filled by a broker so agents never see them.

Work in progress: see the open pull requests for the current phase.
