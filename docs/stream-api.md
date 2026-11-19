# Stream and input API (v1)

The board page gets live view and takeover of a lane's Chrome through this API. There is no standalone viewer. It is plain HTTP, server-sent events (SSE) and JSON POSTs, so a Python stdlib server can relay it. Verified end to end against a real lane before release.

## Reachability and auth

- Separate listener from the agent API. Binds the host's tailnet IPv4 (p620: `100.101.47.28`, port `7621`; `stream.host` and `stream.port` in `/etc/fleet-browser/config.json`). Plain HTTP over the tailnet.
- Every request carries `Authorization: Bearer <token>`. Missing or wrong: `401 {"error": "..."}`.
- Tokens are files named `<client>.token` in `/etc/fleet-browser/tokens.d/`, one per client, 32+ characters. The daemon re-reads the directory every 2 seconds, so adding or deleting a token needs no restart. `sudo deploy/token.sh add <client> [--copy-to <file> --owner <user>]` creates one without printing it; `revoke <client>` deletes it.
- No CORS. The board server calls this API and relays to its page.

## Types

All times are epoch milliseconds (`Date.now()`): `createdAt`, `expiresAt`, `resolvedAt`, `control.since`.

Lane snapshot:

```json
{
  "lane": "main",
  "status": "ready",
  "error": null,
  "chromeVersion": "158.0.8127.36",
  "chromePid": 4242,
  "display": ":121",
  "tabs": [{ "id": "<targetId>", "title": "Sign in", "url": "https://..." }],
  "control": { "kind": "agent" },
  "handoff": { "id": "a1b2c3", "lane": "main", "reason": "solve the captcha", "createdAt": 0, "expiresAt": 0, "status": "open" },
  "credentialStep": false,
  "viewLink": "http://maverick.tail7d4c65.ts.net:7878/#/browser/main"
}
```

- `status`: `stopped | starting | ready | failed`.
- `error`: always present. `null` unless `status` is `failed`, then a one-line reason (for example the Chrome pin mismatch or a crash loop). The board's `snapshot.error` assumption holds.
- `control`: `{ "kind": "agent" }` or `{ "kind": "human", "viewerId": "...", "since": 0 }`.
- `handoff`: `null` or the latest handoff. `status` is `open | done | cancelled | expired`; `resolvedAt` appears once it is not open.
- `credentialStep`: `true` while the service is typing a vault secret, one-time code or emailed code into the lane for the agent (usually under ten seconds). The board can show "agent is signing in"; taking control is refused with `409` until it clears.
- `viewLink`: built from the service's `handoff.linkTemplate` by replacing `{lane}`, the same template the handoff notifications use. On p620 it is `http://maverick.tail7d4c65.ts.net:7878/#/browser/{lane}`. `null` when no template is configured. The lane list route (`#/browser`) is the board's own and the service does not know it.
- `chromeVersion`, `chromePid` and `display` appear once the lane has started; `tabs` is empty unless `status` is `ready`.

## Read

- `GET /v1/lanes`: array of snapshots for every lane the service has seen.
- `GET /v1/lanes/{lane}`: one snapshot. Unknown valid lane names are created stopped.
- `GET /v1/events` (SSE): on connect, one `event: lane` per known lane with its full snapshot, then `event: lane` on every change and `event: handoff` with `{ "lane": "main", "handoff": {...} }` when a handoff opens or resolves. `: ping` comment lines every 15 seconds.

## Live view (SSE)

`GET /v1/lanes/{lane}/stream?viewer={id}&maxWidth=1440&quality=70`

- `viewer`: caller-chosen id (letters, digits, `_`, `-`, up to 48), stable for one page session. It identifies who holds control.
- `maxWidth` 320..1920 (default 1440) and `quality` 30..90 (default 70) shape the JPEG frames. Frames are never taller than the lane screen.
- Starts the lane's browser when stopped. `: ping` every 15 seconds. When the connection closes, control held by that viewer is released after 45 seconds unless the same `viewer` reconnects. A second stream with the same `viewer` replaces the first.

Events:

- `event: state`, data `{ "snapshot": <lane snapshot>, "activeTab": "<targetId>|null", "viewer": { "id": "...", "controlling": false } }`. Sent on connect and on every change.
- `event: frame`, data `{ "seq": 41, "meta": { "deviceWidth": 1439, "deviceHeight": 812, "offsetTop": 0, "pageScaleFactor": 1, "scrollOffsetX": 0, "scrollOffsetY": 0, "targetId": "..." }, "jpeg": "<base64>" }`. Latest-frame-wins: a slow consumer skips frames. The screencast only sends frames when the page changes; the first frame arrives right after connect.
- `event: notice`, data `{ "text": "..." }`.

The view follows the tab the agent last worked in (navigate, click, evaluate, activate), and any newly opened tab.

## Input (control only)

`POST /v1/lanes/{lane}/input?viewer={id}` with `{ "events": [ ... ] }`, applied in order. Returns `{ "applied": n }`. `409` unless this viewer holds control and has an open stream. Batch events per animation frame.

Modifiers bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.

```json
{ "t": "mouse", "type": "mouseMoved|mousePressed|mouseReleased", "x": 120.5, "y": 44, "button": "none|left|middle|right", "buttons": 1, "clickCount": 1, "modifiers": 0 }
{ "t": "wheel", "x": 120, "y": 44, "deltaX": 0, "deltaY": 120, "modifiers": 0 }
{ "t": "key", "type": "keyDown|rawKeyDown|keyUp", "key": "a", "code": "KeyA", "keyCode": 65, "text": "a", "modifiers": 0, "commands": ["selectAll"] }
{ "t": "text", "text": "pasted or soft-keyboard text" }
```

Coordinates are page CSS pixels of the frame on screen: `x = (pointerX - canvasLeft) / canvasWidth * meta.deviceWidth` and `y = (pointerY - canvasTop) / canvasHeight * meta.deviceHeight`. Measured error at canvas widths 1440 and 390: at most 1.0 px and 1.5 px (0.5 px with fractional pointer positions). Use `rawKeyDown` for non-printable keys and `keyDown` with `text` for printable ones. Typed text is never logged.

## Commands

`POST /v1/lanes/{lane}/command?viewer={id}` with one JSON object. Returns `{ "ok": true }`, or `409 {"error": "..."}`. All need an open stream for the viewer.

- `{ "t": "control", "on": true }`: take control. If another viewer holds it: `409`, unless `"force": true`, which takes it over. The displaced viewer gets a `state` event with `controlling: false` and its input starts failing with `409`. Only human viewers can hold control; the agent is locked out, not a viewer.
- `{ "t": "control", "on": false }`: give control back.
- `{ "t": "done" }`: the Done button. Resolves the open handoff as `done` (the waiting agent resumes within a second) and releases control. With no open handoff it only releases control.
- Control required: `{ "t": "navigate", "url": "..." }` (a bare host gets `https://`), `{ "t": "history", "direction": "back|forward" }`, `{ "t": "reload" }`, `{ "t": "tab", "action": "activate|close|new", "id": "<targetId>" }`.
- Phone support, control required: `{ "t": "viewport", "width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": true }` re-lays the page out at that viewport (frame `meta.deviceWidth` and `deviceHeight` become 390 and 844, so the mapping formula stays the same). `{ "t": "viewport", "reset": true }` restores it. The override belongs to this viewer's stream: it is also cleared on Done, on releasing or losing control, and when the stream closes. `width` and `height` are 200..3840 and 200..2400.

While a viewer holds control, or a handoff is open, agent commands that change the page are refused with a message naming the reason. Reads that use the screenshot and accessibility APIs (`snapshot`, `screenshot`) still work; `eval` and `get` are refused because they run page script.

For a phone the board can do either or both: pinch-zoom the full-resolution frame (a 1440 px frame at 3x stays legible), or send the `viewport` command for a real mobile layout. Use the viewport command only for the step the captain is doing; it changes how the site renders.

## Handoff lifecycle (agent side, for reference)

The agent runs `fleet-browser handoff "<reason>" [--wait 30m]`: the lane locks to the captain, the agent's herdr rings (phone push arrives with the captcha phase), and the agent waits. `done` (Done button), `cancelled` and `expired` all release the lane. The board sees it through `/v1/events` and the snapshot.

## Errors

`{ "error": "..." }` with `400` invalid input, `401` auth, `404` unknown route, `409` control or stream conflict, `500` the lane's browser failed (see `error` in the snapshot).
