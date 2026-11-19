# Captchas

`fleet-browser captcha` solves the captcha on the lane's page. When it cannot, it stops, hands the lane to the captain, and waits like `fleet-browser handoff`.

```
fleet-browser captcha                   solve the visible captcha (hCaptcha, reCAPTCHA v2 or Cloudflare Turnstile)
fleet-browser captcha detect            list the captcha frames on the page
fleet-browser captcha --kind hcaptcha   only that kind
fleet-browser captcha --no-handoff      report the failure instead of asking the captain
```

The agent output is the outcome (`solved`, `none`, `failed`, `error`), the kind, seconds, and how many model calls it took. On `failed` and `error` the captain is asked through the usual handoff (herdr ring, board `handoff` event, optional phone notification) and the command returns when the captain presses Done, or on expiry.

## How it works

- **No paid solving services.** Image challenges are solved by a vision model the host calls itself. The solver is a small Python program (`solver/`) that the browser service starts as its own user, per call, against the lane's Chrome over CDP, the same way Cleo's `vehicle_acq_job` does it.
- **hCaptcha:** `hcaptcha-challenger` 0.19.0 (the library Cleo uses) drives the checkbox and every challenge type (image choice, area select, drag and drop). Its model calls are routed to the OpenAI provider in `solver/src/fleet_browser_solver/model.py`, adapted from Cleo's `solver_model.py`. A rejected key or exhausted quota ends the run at once.
- **reCAPTCHA v2:** `solver/src/fleet_browser_solver/recaptcha.py`. Clicks the checkbox like a person (mouse path, pauses). If an image grid appears it screenshots the grid, numbers the tiles, asks the model which tiles match, clicks them, handles the "none left" refresh rounds, presses Verify, and retries a fresh challenge up to four times. It stops at once on Google's "try again later" block.
- **Turnstile:** clicks the widget checkbox. No model.
- While the solver runs, the lane is busy: agent page commands are refused (`captchaStep` is `true` in the snapshot) and the board cannot take control for those seconds.
- Solver work files (challenge screenshots) live in a per-run folder under the service's data directory and are deleted when the run ends.

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
