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
  "home": "/Users/me/fleet-homes/main",
  "hosts": { "p620": ["ssh", "p620"] },
  "args": ["--model", "tier/default"],
  "workerArgs": ["--model", "tier/quick"]
}
```

- `home` is the lane's home folder. The mate runs there.
- `hosts` names the hosts that this mate reaches over SSH. A host that is not listed runs here.
- `args` (optional) are extra Pi arguments for the mate. `workerArgs` are extra Pi arguments for its workers.

Start every mate that is configured on a host:

```sh
~/.fleet/app/bin/fleet up
```

- Each mate runs in its own herdr workspace, `fleet-<lane>`. A mate that already runs is left alone, so `fleet up` is safe to run again.
- A mate continues its conversation when it starts again.
- To start the mates on another host, run `fleet up` there, for example `ssh p620 ~/.fleet/app/bin/fleet up`. To see that host's workspaces in the herdr you already use on another machine, add the host once as a machine there: `herdr machine add p620 --remote-session default`. The mates and their workers run in each host's `default` session.
- To run one mate in the current terminal instead, run `~/.fleet/app/bin/fleet <lane>`.

The home folder can hold an `AGENTS.md` with the lane's charter. The role contract comes from the extension.
