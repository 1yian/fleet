# Captchas

`fleet-browser captcha` solves the captcha on the lane's page. When it cannot, it stops, hands the lane to the captain, and waits like `fleet-browser handoff`.

```
fleet-browser captcha                   solve the visible captcha (hCaptcha, reCAPTCHA v2 or Cloudflare Turnstile)
fleet-browser captcha detect            list the captcha frames on the page
fleet-browser captcha --kind hcaptcha   only that kind
fleet-browser captcha --no-handoff      report the failure instead of asking the captain
```

It works on the calling card's own tab, like the credential commands (see [credentials.md](credentials.md)); a tab that is not an open page of the lane is refused with `409`.

The agent output is the outcome (`solved`, `none`, `failed`, `error`), the kind, seconds, and how many model calls it took. On `failed` and `error` the captain is asked through the usual handoff (herdr ring, board `handoff` event, optional phone notification) and the command returns when the captain presses Done, or on expiry.

## How it works

- **No paid solving services.** Image challenges are solved by a vision model the host calls itself. The solver is a small Python program (`solver/`) that the browser service starts as its own user, per call, against the lane's Chrome over CDP, the same way Cleo's `vehicle_acq_job` does it.
- **hCaptcha:** `hcaptcha-challenger` 0.19.0 (the library Cleo uses) drives the checkbox and every challenge type (image choice, area select, drag and drop). Its model calls are routed to the OpenAI provider in `solver/src/fleet_browser_solver/model.py`, adapted from Cleo's `solver_model.py`. A rejected key or exhausted quota ends the run at once. For "click the item" challenges the library's coordinate-grid screenshot is not used: the model reads positions off axis labels poorly (it answered x=113 for an object at x=207), so the solver sends the plain challenge image and asks for each object's centre as permille of the image, then converts that to page coordinates from the measured challenge box.
- **reCAPTCHA v2:** `solver/src/fleet_browser_solver/recaptcha.py`. Clicks the checkbox like a person (mouse path, pauses). If an image grid appears it screenshots the grid, numbers the tiles, asks the model which tiles match, clicks them, handles the "none left" refresh rounds (each look waits until two screenshots 0.8 s apart are identical and no tile is still blank, so tiles that are still loading are not mistaken for empty ones), presses Verify, and retries a fresh challenge up to four times or until the time budget is used. It stops at once on Google's "try again later" block.
- **Turnstile:** clicks the widget checkbox. No model.
- While the solver runs, the lane is busy: agent page commands are refused (`captchaStep` is `true` in the snapshot) and the board cannot take control for those seconds.
- Solver work files (challenge screenshots) live in a per-run folder under the service's data directory and are deleted when the run ends.

## Measured pass rates

Model `gpt-6.1-terra`, Chrome 158 on the p620 host, a fresh profile for every attempt, vendor demo pages. A pass is the page holding a response token.

| Target | Mode | Attempts | Solved | Median time to solve |
|---|---|---|---|---|
| hCaptcha (accounts.hcaptcha.com/demo) | headless | 30 | 30 | 27 s |
| reCAPTCHA v2 (google.com/recaptcha/api2/demo), image challenge shown every time | headful on Xvfb | 29 | 17 (59%) | 64 s |

- reCAPTCHA in a fresh profile always showed images (a lane's warm profile mostly passes the checkbox without images). Most failures were four consecutive grids rejected, mostly 4x4 "select all squares" grids; the picks on the grids reviewed by eye were right, so what Google wants from a low-trust browser is part of the gap.
- Before the click-placement fix hCaptcha solved 0 of 7. Before the tile-loading fix reCAPTCHA solved 8 of 30 in headless Chrome, which Google distrusts more (3 of 30 after the fix, with long waits eating the time budget).
- Expect hCaptcha and reCAPTCHA to end in a handoff now and then. First-party Meta and Google captchas are not covered by these numbers.

## Limits

- Audio challenges, hCaptcha Enterprise "hold" puzzles and Arkose/FunCaptcha are not handled; they end in a handoff.
- A challenge that is only shown after the agent's own click is solved by calling `captcha` right after the click.
- Meta's and Google's first-party login captchas may refuse a solved token; expect handoffs there.
- Terms of service: automated captcha solving breaks the terms of many sites. Use it on accounts where that risk is accepted.

## Setup on a host

`deploy/install.sh` builds the solver virtualenv (`solver/requirements.txt`, pinned) and adds a `captcha` block to `/etc/fleet-browser/config.json`. Two captain-owned inputs:

1. `FLEET_BROWSER_SOLVER_MODEL=<model id> sudo deploy/install.sh`: the OpenAI vision model to call (Cleo uses the one in its `solver_model.py`).
2. `sudo deploy/solver-key.sh set`: the OpenAI API key, stored at `/etc/fleet-browser/openai.key` (root and the service user only; agents cannot read it).

Phone notifications: `sudo deploy/notify.sh set https://ntfy.sh` and paste a private topic; subscribe to the same topic in the ntfy phone app.
