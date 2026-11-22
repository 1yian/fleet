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
6. A captcha on the page: `fleet-browser captcha`. It solves hCaptcha, reCAPTCHA v2 and Cloudflare Turnstile. If it cannot, it hands the lane to the captain by itself and returns after Done; then continue with `snapshot -i`. Run it right after the click that triggers the captcha. Never call it in a loop.
7. When a step needs the captain (captcha you cannot pass, phone approval, payment, terms), run `fleet-browser handoff "<what the captain should do>"`. It locks the lane, notifies the captain, and waits. When it prints `handoff: done`, run `fleet-browser snapshot -i` and continue. On `expired`, report that the step is blocked.

Rules:
- Other cards may be working in the same lane at the same time. When `FLEET_ATTEMPT` is set (every fleet worker has it), the lane's Chrome gives you a tab of your own: your first command opens it (a `snapshot` or `eval` before any `open` shows a blank page), and `open`, `tab new` and `tab <id>` only move your tab, never another card's. Sign-ins and cookies are shared by the whole lane, so a login done by one card holds for the others.
- `fleet-browser tab list` and `fleet-browser` list every tab of the lane's Chrome; the one marked active (or `owner: this card`) is yours. You cannot select or close another card's tab: it is refused, so leave those tabs alone. Vault-backed `login <item>`, `otp`, `mail`, `captcha` and `handoff` always act on your tab; `login --stdin` works in its own private tab and leaves your tab untouched, so reopen the site afterwards.
- While the captain drives, a handoff is open, or any card's `login`, `otp`, `mail` or `captcha` runs, page commands from every card of the lane are refused with a message saying so; retry when it ends. `snapshot` and `screenshot` still work during a captain takeover or handoff.
- Never read cookies, passwords or one-time codes, or type a password into a page yourself. For an authorized sign-in with no vault item, use `fleet-browser login --stdin < /path/to/private-envelope` only if a trusted source has already supplied a protected envelope for this lane, exact site origin and sign-in URL. Use the file or pipe without reading it. Do not put a credential in a tool call, chat, shell literal, argument or environment variable.
- `localhost` and private addresses open in the lane's Chrome on the browser host, not on your machine. For a dev server on your own machine use dev mode: `fleet-browser dev open http://localhost:3000`, then the same verbs after `dev`, `fleet-browser dev console` for console messages plus uncaught errors, and `fleet-browser dev close` when done. Dev mode has no sign-ins and nothing persists.
