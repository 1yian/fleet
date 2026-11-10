# Fleet Chrome: take a worker's tab into a real Chrome on your Mac

This is a prototype (card c-1289). It installs nothing, runs only when you start it, and never touches the worker's tab until you say `back`.

The shared Chrome of a host belongs to the workers. When you must sign in yourself, or want a real Chrome with your own keys and extensions, `fleet-chrome` opens the worker's page in a real Chrome on this machine, with the worker's session copied in, and routes that Chrome's traffic through the host. When you are done, it sends the session back and reloads the worker's tab.

It has two entries for a tab:

- **Take over** (`fleet-chrome take`): a real local Chrome, described below.
- **Watch live**: the viewer that already exists (the captain's viewer, [setup.md](setup.md#the-viewer)). Use it when the page must not reload: a half-finished form, an OAuth redirect in flight, a passkey or device-bound step that only the host's Chrome can do. Taking over a tab does not change the viewer, and the viewer does not change the tab, so both can be open at once.

## Try it on a Mac

You need Node 24 or newer, git, Google Chrome in `/Applications` (or `FLEET_CHROME_BIN`, below), and `ssh <host>` that works with no prompt (a key, not a password) to the host whose Chrome the workers use. That host needs `node` on the path of a non-interactive ssh session, which the fleet already requires ([Prerequisites](setup.md#prerequisites)). Its shared Chrome must listen on `127.0.0.1:9222`, as [setup.md](setup.md#what-a-hosts-chrome-service-must-provide) says.

```sh
git clone https://github.com/1yian/fleet ~/fleet-chrome-try
cd ~/fleet-chrome-try
git checkout fix/viewer-daily-usability
npm ci
```

- `git clone` and `checkout` put the code in one folder. Nothing is installed anywhere else. After the pull request is merged, stay on `main`.
- `npm ci` installs the code's dependencies inside that folder.

```sh
bin/fleet-chrome list --host p620
```

Reads the page titles and addresses of the host's Chrome over ssh and prints them with a number. It opens no Chrome and changes nothing. Run it first: if it prints your worker's tabs, ssh, `node` on the host, and the port are right.

```sh
bin/fleet-chrome take 1 --host p620 --lane main
```

What happens, in order:

1. It reads tab 1 over ssh: the cookies that Chrome would send to its address (including `HttpOnly`, `Secure`, `Partitioned`, and cookies of the parent domain), its `localStorage`, and its `sessionStorage`. It prints only the counts.
2. It starts `ssh -N -D 127.0.0.1:<port> p620`, a SOCKS proxy that ends on the host.
3. It starts `/Applications/Google Chrome.app` with its own profile, `~/.fleet-chrome/main/profile` (the name after `--lane`), and with every request sent through that proxy. Even `localhost` and `127.0.0.1` go through it, so a worker's dev server on the host's `localhost:3000` opens as it does for the worker.
4. It replaces what that profile holds for the site with the copy, then opens the same address.
5. You use the site in that Chrome: sign in, type a password, use Touch ID or your password manager's extension, click through.
6. In the terminal, type one of these and press Enter:
   - `back`: send what this Chrome now holds to the worker's tab (its cookies for the site, `localStorage`, and `sessionStorage` replace the tab's), then reload the worker's tab. The copy is removed from the Mac profile and Chrome quits.
   - `back --force`: the same, when `back` refused because the worker's tab changed while you held it (it names what changed).
   - `discard` (or Ctrl-C): leave the worker's tab as it is, remove the copy from the Mac profile, and quit Chrome.

Use one `--lane` name for each lane, so two lanes never share one cookie jar: a second copy of the same site into one profile replaces the first. Only one takeover can run for a profile at a time; a second one is refused and says so.

`take` takes a number from `list`, the start of a tab id, or text from its address or title. It stops and lists the candidates when the text matches none or more than one.

`FLEET_CHROME_HOME` moves the profile folder (default `~/.fleet-chrome`). `FLEET_CHROME_BIN` names another Chrome to start, and `FLEET_CHROME_ARGS` adds arguments to it.

To bring cookies of a second site along, such as a single sign-on page, add `--also https://accounts.example.com/`. It can be repeated.

### Undo everything

- A takeover in progress: type `discard`.
- Everything on disk: `rm -rf ~/fleet-chrome-try ~/.fleet-chrome`.
- Nothing else exists: no launchd job, no login item, no proxy setting, no PAC file, no Chrome extension, no change to `~/.ssh` or to Chrome's own profile.
- If a run was killed hard (power loss, `kill -9`) and left processes: quit the Chrome window that uses `~/.fleet-chrome`, and end the `ssh -N -D` process (`ps aux | grep 'ssh -N -D'`, then `kill <pid>`).
- What `back` replaced on the worker's tab is not kept. If a worker's tab was signed in as another account and you do not want that replaced, use `discard`.

## What crosses, and what does not

| Crosses                                                     | Stays behind                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookies for the tab's address and for each `--also` address | A password you type (it is in the page, not in cookies or storage)                                                                                              |
| `localStorage` and `sessionStorage` of the tab's own origin | `IndexedDB`, `Cache Storage`, service workers, form drafts, in-page state                                                                                       |
| Traffic: every request of that Chrome leaves from the host  | Cookies of other sites that you did not name with `--also`                                                                                                      |
|                                                             | Passkeys and any key that stays in a device (Touch ID, a security key, Chrome's device-bound session keys): a session that needs one refreshes only on the host |
|                                                             | Storage of iframes from other origins                                                                                                                           |

## Rules it keeps

- A password you type goes to the site from the Mac. `fleet-chrome` never types, reads, or prints a form value. The worker's tab never receives it, and after `back` its page holds no password you typed. What the worker's tab does hold is the session you made (cookies and tokens), and a worker's `eval` can read `localStorage` tokens, as it can today. It cannot read an `HttpOnly` cookie through the page.
- It prints counts, names of what changed, and errors. It never prints a value.
- Nothing is written outside the Mac profile folder, and `back` and `discard` remove the copied session from it (cookies, `localStorage`, `IndexedDB`, caches, and service workers of that site). Chrome's history and HTTP cache for the site stay in the profile: delete `~/.fleet-chrome/<lane>` to remove those too.
- It reaches the host the way the fleet does: `ssh <host>` for the host's Chrome, which stays on its own `127.0.0.1`, and `ssh -D` bound to `127.0.0.1` of the Mac. Nothing listens on a network address and nothing is forwarded.
- `back` replaces the worker's session with what the Mac holds. It does not merge. It refuses, and names what changed, when the worker's tab changed while you held it.

## What the prototype cannot do yet

- No Chrome extension, tab list, or omnibox keyword. You start it from a terminal. A small extension that lists the workers' tabs and starts a takeover is the next step, and it needs a native messaging host.
- It does not pause the worker. The worker's tab stays live. `back` can see what changed in the worker's cookies and storage, but not what changed on the server: if the worker or the Mac rotates a one-time refresh token (Supabase and many OAuth sites), the other side's copy dies at the next refresh. Take over a tab when the worker is idle on it.
- `back` reloads the worker's tab where it is. It does not follow the page you ended on in the Mac Chrome.
- If you quit Chrome with Cmd+Q during a takeover, the Mac copy is gone and nothing is sent back. The copied session may remain in the profile folder until you delete `~/.fleet-chrome/<lane>`.
- A site that checks that a session stays with one device (a passkey step-up, Google's device-bound sessions, a key that cannot be exported) refuses the copy or the refresh. Watch live is the way to see that page.
- Sessions bound to an address work only when both Chromes leave from the host. Traffic that does not go through the SOCKS proxy (WebRTC over UDP) is switched off in this Chrome, but I did not test a site that uses it.
- The Mac Chrome has a debugging port on `127.0.0.1` while it runs, because that is how `fleet-chrome` talks to it. Any process of your own account can use it to read that profile.
- The host must be a plain `ssh <host>` name. A host that needs `gcloud compute ssh` (IAP) does not work, because the proxy needs ssh's `-D`.
- It was not run on a real Mac. It was run in the end-to-end test (`e2e/extension/fleet-chrome.test.ts`), which starts a real Chromium as the Mac, another as the host's shared Chrome, a real cardd and worker, and a fake `ssh` that serves `-D` itself, and once by hand over a real `ssh -N -D` to an `sshd` on loopback.
- Real sites were not used. The auth site of the test has a session cookie, a `Domain` cookie, a `localStorage` token, and a `sessionStorage` draft.
