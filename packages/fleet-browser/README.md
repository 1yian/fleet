# fleet-browser

Browser for agents. One real, version-pinned Google Chrome per lane, headful on its own virtual display, launched and supervised by a service. Agents drive it through the `fleet-browser` CLI (agent-browser underneath, attached over CDP); the captain watches and takes over from a page in the Firstmate board through the stream API in [docs/stream-api.md](docs/stream-api.md).

## What runs where

```
agent --> fleet-browser CLI --> agent-browser --cdp --> service CDP proxy (loopback :7620) --> lane Chrome
board page --> board server --> stream API (tailnet :7621, bearer token) --> service --> same lane Chrome
service --> credential broker (Unix socket, own user) --> 1Password / IMAP
service --> captcha solver (Python, per call, same user) --> lane Chrome over CDP, vision model over HTTPS
```

- One service per host (systemd). Runs as its own Unix user, so lane profiles (cookies, sessions) are unreadable to agents.
- One lane = one Chrome, one Xvfb display (with an Xauthority only the service user holds), one profile at `/var/lib/fleet-browser/lanes/<lane>/profile`, one CDP port in 9321+. Lanes start on first use.
- Cards of one lane share that Chrome and profile, so sign-ins are shared, and each works in a tab of its own: with `FLEET_ATTEMPT=<card>` set (fleet exports `c-<N>-a<M>` to every worker) the CLI runs its own pinned agent-browser session `fb-<lane>_c<N>a<M>`, and `login`, `otp`, `mail`, `captcha` and `handoff` tell the service which tab is the card's. A card cannot select or close another card's tab. Without `FLEET_ATTEMPT` the lane has one shared session `fb-<lane>`. The lane-wide locks (captain driving, handoff, credential step, captcha step) stay lane-wide.
- Chrome is the system `google-chrome-stable`, held with `apt-mark hold`; the service refuses to start a lane when the installed version differs from `chrome.version` in the config.
- Chrome's own debug ports are blocked for every Unix user except the service (nftables owner match, loaded by the unit). Agents reach the browser only through the CDP proxy, which refuses page-changing commands while the captain drives or a handoff is open, and never forwards `Browser.close` or cookie reads.
- Stealth is "do nothing unusual": real Chrome, headful, no automation flags, the lane's own persistent profile, WebGL via SwiftShader, 8 CPUs of affinity so `hardwareConcurrency` is 8.

## Agent CLI

Set `FLEET_BROWSER_LANE=<lane>` in the lane's environment (or pass `--lane`).

```
fleet-browser                          lane status
fleet-browser open <url>               navigate the lane's Chrome
fleet-browser snapshot -i              interactive elements with refs
fleet-browser click|fill|type|press|scroll|wait|screenshot|eval|get|find|tab ...
fleet-browser login <item>             sign in from the lane's vault; the agent never sees the secrets
fleet-browser otp <item> [--submit]    one-time code from the vault into the page
fleet-browser mail link|code <item>    follow an emailed link or type an emailed code
fleet-browser captcha                  solve hCaptcha / reCAPTCHA / Turnstile; hands off if it cannot
fleet-browser dev [--headful] <verb>   throwaway browser for your own dev server (docs/dev-mode.md)
fleet-browser handoff "<reason>"       lock the lane, notify the captain, wait for Done
fleet-browser lanes [--watch]          every lane (the herdr plugin pane runs --watch --notify)
```

Browser verbs are passed to agent-browser 0.43.0 (pinned in `package.json`); see `skills/fleet-browser/SKILL.md`. Credential commands are described in [docs/credentials.md](docs/credentials.md), captcha solving in [docs/captcha.md](docs/captcha.md), dev mode in [docs/dev-mode.md](docs/dev-mode.md).

## Install the CLI and skill

Run `bun install --frozen-lockfile` and `bin/fleet install` from the host's Fleet checkout. This builds the browser package and links `~/.local/bin/fleet-browser` and installs the skill in Pi's agent directory (`~/.pi/agent/skills` by default). Remove any old `fleet-browser` skill registration in `~/.agents/skills` or in the host's configuration manager. Install and update replace only links: a real skill directory or file at the target is left intact and reported as a conflict. Fleet's `update_fleet` rebuilds the package and refreshes the same links. No standalone checkout or browser release is needed.

## Install the daemon on a browser host

Requirements: Node 24, Bun, `google-chrome-stable`, `xvfb`, `xauth`, `nftables`, `taskset`, `unzip`, `curl`, Tailscale.

The daemon, the broker, and the privileged credential import run code, build output, and dependencies from the checkout that installs them, and the broker holds the 1Password service-account token. Deploy from a dedicated checkout that only deployment administrators can write, outside home directories (the broker's systemd unit cannot read `/home` or `/root`), and readable by the service users. Never deploy from the regular Fleet checkout that lanes manage. Its `node_modules` and `dist` must be root-owned too, so run the build steps below as the administrator that owns the checkout.

```sh
sudo git clone https://github.com/1yian/fleet /opt/fleet-browser-deploy
cd /opt/fleet-browser-deploy
sudo bun install --frozen-lockfile
sudo bun run --cwd packages/fleet-browser build
cd packages/fleet-browser
sudo NODE_BIN="$(command -v node)" FLEET_BROWSER_LINK_TEMPLATE='http://<board host>:7878/#/browser/{lane}' deploy/install.sh
sudo deploy/token.sh add board --copy-to ~/.config/fleet-browser/board.token --owner "$USER"
herdr plugin link "$PWD/herdr-plugin"
```

Run `deploy/broker-import.sh` from this same checkout: it loads `dist/broker/import.js` next to the script, as root, with the broker's token and the submitted password.

For an existing browser host, check out the dedicated deploy checkout as above, rebuild it, and rerun `deploy/install.sh` from its package during a browser maintenance window. It updates both systemd units and the solver path, restarts the services, and retains the existing Chrome profiles, configuration, and tokens. Do not run the token-add command again. Relink the Herdr plugin if it pointed at the old checkout. For later updates, `git pull` and rebuild that checkout as the administrator, then use the same installer to load the updated code. Fleet does not restart active browser sessions automatically.

`deploy/uninstall.sh` removes the service; profiles stay unless `PURGE_DATA=1`.
