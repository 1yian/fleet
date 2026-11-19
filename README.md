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
fleet-browser handoff "<reason>"       lock the lane, notify the captain, wait for Done
fleet-browser lanes [--watch]          every lane (the herdr plugin pane runs --watch --notify)
```

Browser verbs are passed to agent-browser 0.43.0 (pinned in `package.json`); see `skills/fleet-browser/SKILL.md`. Credential commands are described in [docs/credentials.md](docs/credentials.md), captcha solving in [docs/captcha.md](docs/captcha.md).

## Install on a host

Requirements: Node 24, `google-chrome-stable`, `xvfb`, `xauth`, `nftables`, `taskset`, `unzip`, `curl`, Tailscale.

```sh
git clone https://github.com/1yian/fleet-browser /opt/fleet-browser && cd /opt/fleet-browser
npm ci && npm run build
sudo NODE_BIN=$(command -v node) FLEET_BROWSER_LINK_TEMPLATE='http://<board host>:7878/#/browser/{lane}' deploy/install.sh
sudo deploy/token.sh add board --copy-to ~/.config/fleet-browser/board.token --owner $USER
ln -s /opt/fleet-browser/bin/fleet-browser.js ~/.local/bin/fleet-browser
herdr plugin link /opt/fleet-browser/herdr-plugin
```

`deploy/uninstall.sh` removes the service; profiles stay unless `PURGE_DATA=1`.
