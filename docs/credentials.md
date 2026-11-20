# Credentials, one-time codes and mail

Agents sign in, answer two-step prompts and follow emailed links without ever holding the secret. A second service, the credential broker, reads secrets from 1Password and the lane's mailbox. The browser service types them into the page. The agent gets a short result.

```
agent --> fleet-browser login <item> --> browser service --> broker (Unix socket) --> 1Password / IMAP
                                              |
                                              +--> types into the lane's Chrome over CDP
```

## Commands

```
fleet-browser login <item>                       username, password and one-time code, in whatever order the page asks
fleet-browser otp <item> [--submit]              current one-time code into the focused or visible code field
fleet-browser mail link <item> [--match <re>] [--since 10m] [--wait 60s]
                                                 open the newest matching emailed link in the lane
fleet-browser mail code <item> [--match <re>] [--pattern <re>] [--since 10m] [--wait 60s] [--submit]
                                                 type the newest matching emailed code into the focused or visible code field
fleet-browser broker status                      local read budget and 1Password rate limit
```

`<item>` is an item title in the lane's vault (`fleet-browser-<lane>`). `login` and `otp` use a Login item (username, password, one-time password, website). `mail` uses an item that holds the lane's mailbox: username, password (an app password) and optional custom fields `server`, `port`, `tls` (default Zoho IMAP, `imap.zoho.com:993`).

What the agent sees back: the steps taken (`username, password, otp`), the resulting page title and URL, and the words from a fixed list that the page showed (`incorrect`, `try again`, `locked`, `captcha`, ...). Page text is never copied into the answer.

## Rules the service enforces

- **Origin binding.** The page must be on a website listed on the item, and is re-checked before every field is typed. A redirect to another host stops the login with `off-origin` before the password is typed. For single sign-on, list the identity provider as an extra website on the item (for example `accounts.google.com`) so the whole redirect chain is allowed.
- **No retries.** One password attempt per `login`. A second one-time code is tried only when the code has rolled over. A wrong password returns `stuck` with what the page said, so a lockout is never provoked.
- **No peeking.** While a credential step runs, the lane's CDP proxy refuses everything except attach and domain enable/disable, so the agent cannot evaluate scripts, snapshot or screenshot the page. Network events the agent listens to carry no request bodies, and cookie and authorization headers are redacted. `Network.getRequestPostData` and every cookie read are refused at all times.
- **Cleanup.** After a login, any password or code field still holding a value is cleared. `otp` and `mail code` without `--submit` leave the single-use code in the field so the agent can press the page's own button.
- **One broker token, one vault per lane.** The broker holds a single 1Password service account token that can create vaults and read the owner's Personal vault. The token sits in `/etc/fleet-browser-broker/op-token` (root, mode 600) and reaches the broker only as a systemd credential; no lane, agent or service user can read it. Every lane has its own vault `fleet-browser-<lane>`, created by the broker. A lane can read only that vault: the broker derives the vault from the lane name, refuses lanes missing from its root-owned config, and refuses item names that look like references or links.
- **Nothing leaves Personal except an explicit list.** The root-owned broker config (`/etc/fleet-browser-broker/config.json`) lists, per lane, the exact titles of Personal items to copy. At every broker start the broker copies each listed item into the lane's vault (replacing the previous copy) and deletes copies that are no longer listed. Personal is only ever read, and only by exact title. Items the lane owns (created with `deploy/broker-import.sh`, tagged `fleet-browser-lane-owned`) are never touched by the sync.
- **Budget.** 1Password service accounts on an Individual account allow 1000 reads per hour per token and 1000 reads and writes per day across all of the account's service accounts (Business: 10,000 and 50,000). The broker counts reads locally (an item by name costs 3 reads once, then by id 1; sync calls count too), refuses past `dailyReadBudget` (800), and caches the mailbox item for 5 minutes. `fleet-browser broker status` shows both.
- **Audit.** Every secret, otp, mail and status request, and every sync copy, is appended to `/var/lib/fleet-browser-broker/audit.log` with lane, item and outcome. Secrets are never logged.

## One-time setup

1. Create a 1Password service account that is allowed to create vaults and read the Personal vault (`op service-account create fleet-browser-broker --can-create-vaults --vault Personal:read_items`), and store its token on the browser host: `sudo deploy/broker-token.sh set` (input hidden; the broker restarts).
2. Declare each lane and, if it needs a login that already lives in Personal, the exact item title: `sudo deploy/broker-lane.sh lane <lane>` and `sudo deploy/broker-lane.sh allow <lane> "<Personal item title>"`. Each call restarts the broker, which creates the vaults and syncs the copies. `deploy/broker-lane.sh show` lists the lists; `deny` removes a title and its copy.
3. For a login that is not in Personal, give it to the lane directly. The password goes in on stdin and is never printed: `sudo deploy/broker-import.sh <lane> <item title> <username> <https website> < password-file`.
4. For mail: provide the mailbox as a lane item with username and app password. Zoho IMAP is the default. A mailbox on another server needs the optional custom fields `server`, `port`, `tls` on the item, which only the Personal route (step 2) can carry; the import in step 3 creates just username, password and website.

`deploy/install.sh` installs the 1Password CLI (`op` 2.42.0, checksum pinned), the broker unit and a root-owned broker config.
