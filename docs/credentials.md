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

`<item>` is an item name in the lane's vault (`fleet-browser-<lane>`). `login` and `otp` use a Login item (username, password, one-time password, website). `mail` uses an item that holds the lane's mailbox: username, password (an app password) and optional custom fields `server`, `port`, `tls` (default Zoho IMAP, `imap.zoho.com:993`).

What the agent sees back: the steps taken (`username, password, otp`), the resulting page title and URL, and the words from a fixed list that the page showed (`incorrect`, `try again`, `locked`, `captcha`, ...). Page text is never copied into the answer.

## Rules the service enforces

- **Origin binding.** The page must be on a website listed on the item, and is re-checked before every field is typed. A redirect to another host stops the login with `off-origin` before the password is typed. For single sign-on, list the identity provider as an extra website on the item (for example `accounts.google.com`) so the whole redirect chain is allowed.
- **No retries.** One password attempt per `login`. A second one-time code is tried only when the code has rolled over. A wrong password returns `stuck` with what the page said, so a lockout is never provoked.
- **No peeking.** While a credential step runs, the lane's CDP proxy refuses everything except attach and domain enable/disable, so the agent cannot evaluate scripts, snapshot or screenshot the page. Network events the agent listens to carry no request bodies, and cookie and authorization headers are redacted. `Network.getRequestPostData` and every cookie read are refused at all times.
- **Cleanup.** After a login, any password or code field still holding a value is cleared. `otp` and `mail code` without `--submit` leave the single-use code in the field so the agent can press the page's own button.
- **One lane, one vault.** Each lane has its own 1Password service account token (`/etc/fleet-browser-broker/tokens/<lane>.token`, owned by the broker user, mode 600). The broker user and the service user are different Unix users; the agent user can read neither the tokens nor the broker socket.
- **Budget.** 1Password service accounts on an Individual account allow 1000 reads per hour per token and 1000 reads and writes per day across all of the account's service accounts (Business: 10,000 and 50,000). The broker counts reads locally (an item by name costs 3 reads once, then by id 1), refuses past `dailyReadBudget` (800), and caches the mailbox item for 5 minutes. `fleet-browser broker status` shows both.
- **Audit.** Every secret, otp, mail and status request is appended to `/var/lib/fleet-browser-broker/audit.log` with lane, item and outcome. Secrets are never logged.

## One-time setup (needs the account owner)

1. Create a 1Password Individual account.
2. For each lane `<lane>`: create a vault named `fleet-browser-<lane>`, put the lane's Login items (with the website field filled in) and its mailbox item in it, then create a service account with read-only access to that vault only.
3. On the browser host: `sudo deploy/broker-token.sh set <lane>` and paste the token (input hidden). `remove <lane>` deletes it.
4. For mail: enable IMAP on the Zoho mailbox, create an app password, store it in the mailbox item.

`deploy/install.sh` installs the 1Password CLI (`op` 2.42.0, checksum pinned) and the broker unit.
