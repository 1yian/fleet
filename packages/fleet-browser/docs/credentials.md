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
fleet-browser login --stdin                      single-use non-vault login from a private input stream
fleet-browser otp <item> [--submit]              current one-time code into the focused or visible code field
fleet-browser mail link <item> [--match <re>] [--since 10m] [--wait 60s]
                                                 open the newest matching emailed link in the lane
fleet-browser mail code <item> [--match <re>] [--pattern <re>] [--since 10m] [--wait 60s] [--submit]
                                                 type the newest matching emailed code into the focused or visible code field
fleet-browser broker status                      local read budget and 1Password rate limit
```

`<item>` is an item title in the lane's vault (`fleet-browser-<lane>`). `login` and `otp` use a Login item (username, password, one-time password, website). `mail` uses an item that holds the lane's mailbox: username, password (an app password) and optional custom fields `server`, `port`, `tls` (default Zoho IMAP, `imap.zoho.com:993`).

A vault-backed step runs on the calling card's own tab (the active tab of its pinned `fleet-browser` session), so two cards of one lane can sign in side by side. A card without `FLEET_ATTEMPT` has no tab of its own and the step uses the tab the lane worked in last. The service refuses a tab that is not an open page of the lane with `409`. While the step runs, the board's viewer shows that tab (direct sign-in below uses a private tab the board never shows), and page commands from every card of the lane are paused.

For vault-backed steps, what the agent sees back: the steps taken (`username, password, otp`), the resulting page title and URL, and the words from a fixed list that the page showed (`incorrect`, `try again`, `locked`, `captcha`, ...). Page text is never copied into the answer.

## Direct sign-in without a vault item

Run `fleet-browser login --lane <lane> --stdin < /path/to/private-envelope`. Use only an existing protected file or pipe populated by a trusted credential source. Do not copy a password from a chat, card, or tool result, or use an inline shell literal, command argument, or environment variable. This command does not provide or retrieve credentials; if no protected input exists, it cannot use a password supplied in conversation without exposing it again.

Stdin accepts one UTF-8 JSON object of at most 16 KiB with `lane`, `origin`, `url`, `password` and optional `username` string fields. The origin is canonical and exact: for example `https://login.example.com` with no trailing slash, path or query. HTTPS is required, and scheme and port matter. `url` is the sign-in page to load and must be on that exact origin, without embedded credentials. The envelope's lane must match the selected lane. The browser service must be on the CLI's own host at a literal loopback HTTP URL; do not relay these requests through a proxy. The CLI does not follow service redirects.

Direct sign-in is for a trusted site's visible password form that submits a POST to the same origin in the same tab, with a username field in that form if a username is supplied. The form needs exactly one eligible password field and, when a username is supplied, exactly one eligible username field: visible, named, enabled and not read-only. Multi-page sign-in, SSO and OTP still use the vault-backed commands.

The step never touches an existing tab and takes no tab from the caller, so the calling card's pinned tab never shows the sign-in form. Fleet Browser closes agent browser connections to that lane, opens a fresh private tab that the board and tab lists never show, turns on service worker bypass for it before its first navigation, loads `url`, and checks that the loaded document is on the exact HTTPS origin. In an isolated world it inspects the form (exactly one eligible password field, same-tab target, `POST`, `application/x-www-form-urlencoded`, HTTPS action on the exact origin) and records the action URL and field names. It then arms a browser guard and, in a second isolated-world call that re-checks the same plan, sets the username and password without firing page events and calls the browser's native form `submit()`. No page submit handler, input handler or key press is involved, and no submit button is needed. The guard fails any request that is not HTTPS, carries a body to another origin or a body it cannot read, or carries the password anywhere except the one main-frame `POST` to the planned action whose body holds the password (and username) under the planned field names; a redirect that replays the credential is blocked. `done` requires that `POST` to have been released by the browser, answered with an HTTP status below 400, and the resulting document to have loaded, then no login fields; otherwise the outcome is `stuck`.

The site owns its scripts and legitimately receives its own credential: a script the site serves, including a native `formdata` callback, can read what the form submits. Direct sign-in only excludes scripts the agent installed before delivery and unrelated origins, so use it only on a site you trust.

The private tab is verified closed before the lane is released. If that cannot be verified, the lane is not released: it stays paused with its Chrome and profile untouched until it is stopped. Sign-ins and cookies are shared by the whole lane, so the calling card's own tab can reopen the site and is signed in. It stores no vault item and returns only a fixed outcome. A successful status is not proof of authentication, so verify the signed-in state before continuing.

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

`deploy/install.sh` installs the 1Password CLI (`op` 2.42.0, checksum pinned), the broker unit and a root-owned broker config (group `fleet-browser`, mode 640) that the broker service can read.
