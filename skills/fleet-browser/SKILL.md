---
name: fleet-browser
description: Drive the lane's persistent real Chrome (sign-ins stay signed in) with the fleet-browser CLI, and hand a step to the captain when you cannot do it. Use for any website task that needs a real browser session.
---

# fleet-browser

Your lane has one persistent Chrome. Cookies and logins survive between tasks. Run everything through `fleet-browser`; never launch another browser.

1. `fleet-browser` shows the lane, the browser state and any open handoff.
2. `fleet-browser open <url>` then `fleet-browser snapshot -i` lists interactive elements as `@e1`, `@e2`. Refs change after every snapshot; snapshot again before clicking.
3. Act: `click @e3`, `fill @e4 "text"`, `press Enter`, `scroll down`, `wait 2000`, `screenshot /path.png`, `tab list`, `eval "<js>"`.
4. Sign in with the vault, not by typing: open the sign-in page, then `fleet-browser login <item>`. It types the username, password and one-time code and tells you the result. Two-step prompt alone: `fleet-browser otp <item> --submit`. Emailed link or code: `fleet-browser mail link|code <item> --match "<subject words>" --wait 60s` (add `--submit` for a code). While one of these runs, page reads are paused; wait for it to return.
5. When `login` says `stuck`, `off-origin` or `needs-otp`, do not retry it: read the hints, check the page with `snapshot -i`, and hand off if you cannot proceed.
6. When a step needs the captain (captcha you cannot pass, phone approval, payment, terms), run `fleet-browser handoff "<what the captain should do>"`. It locks the lane, notifies the captain, and waits. When it prints `handoff: done`, run `fleet-browser snapshot -i` and continue. On `expired`, report that the step is blocked.

Rules:
- While the captain drives or a handoff is open, anything that changes the page is refused with a message saying so. `snapshot` and `screenshot` still work.
- Cookies, passwords and one-time codes are never available to you. Do not try to read them, and never type a password you were given into a page yourself.
- `localhost` and private addresses open in the lane's Chrome on the browser host, not on your machine.
