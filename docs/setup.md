# Setup

This sets up the fleet on hosts that share a Tailscale network. One host runs `cardd`. Every host that runs mates or workers has a copy of this repository.

## 1. A stable copy on each host

Keep the copy that runs the fleet apart from any development checkout:

```sh
git clone https://github.com/1yian/fleet ~/.fleet/app
cd ~/.fleet/app && npm ci && npm run build
```

Each host needs Node 24 or later, Pi, herdr, git, `gh` (logged in), `zstd`, and `no-mistakes` for projects that use it.

To update later: `git -C ~/.fleet/app pull && (cd ~/.fleet/app && npm ci && npm run build)`, then restart `cardd` and the mates.

## 2. cardd

`cardd` runs on one host and binds to that host's Tailscale address. It refuses every-interface addresses, because the board has no login.

```sh
CARDD="node $HOME/.fleet/app/packages/cardd/src/main.ts"
mkdir -p ~/.fleet
IP=$(tailscale ip -4)
NAME=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
$CARDD serve --db ~/.fleet/cards.db --listen "$IP:7420" --hostname "$NAME:7420" --board ~/.fleet/app/packages/board/dist
```

On macOS, run it under launchd with `KeepAlive` so it restarts after a crash or a reboot. The board is then at `http://<NAME>:7420/`.

## 3. Lanes and projects

Run these once on the `cardd` host. `lane add` prints the mate's token.

```sh
$CARDD lane add main --db ~/.fleet/cards.db --home ~/fleet-homes/main
$CARDD lane add cleo --db ~/.fleet/cards.db --home /path/on/its/host --parent main
$CARDD project add web --db ~/.fleet/cards.db --delivery no-mistakes --capacity 2 \
  --clone maverick=/path/to/web --clone p620=/path/on/p620/web
$CARDD grant add --db ~/.fleet/cards.db --lane main --project web --merge --words "<where the permission came from>"
```

- A project's clone is a normal clone of the repository on that host. Dispatch creates each worker's worktree next to it, in `<clone>.worktrees/`.
- Use the same host names in `--clone` that mates pass to `dispatch`.

## 4. Mates

Write each lane's settings on the host where its mate runs, in `~/.config/fleet/<lane>.json`:

```json
{
  "url": "ws://<cardd Tailscale address>:7420/session",
  "token": "<the token from lane add>",
  "hosts": { "p620": ["ssh", "p620"] },
  "workerArgs": ["--model", "tier/quick"]
}
```

- `hosts` names the hosts that this mate reaches over SSH. A host that is not listed runs here.
- `model` (optional) is the mate's own model. `workerArgs` are extra Pi arguments for its workers.

Start the mate in a herdr pane, in the lane's home folder:

```sh
cd ~/fleet-homes/main && ~/.fleet/app/bin/fleet main
```

The home folder can hold an `AGENTS.md` with the lane's charter. The role contract comes from the extension.
