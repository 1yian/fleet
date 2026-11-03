state=${XDG_STATE_HOME:-$HOME/.local/state}/fleet/contain
record=$state/$unit

backend_attach() {
  mkdir -p "$state"
  group=$(ps -o pgid= -p "${roots%% *}" 2>/dev/null | tr -d ' ')
  [ -z "$group" ] || echo "$group" >"$record"
}

group_of_record() {
  [ -s "$record" ] || return 1
  cat "$record"
}

backend_members() {
  group=$(group_of_record) || return 0
  [ "$group" != "$(ps -o pgid= -p $$ | tr -d ' ')" ] || return 0
  ps -axo pid=,pgid= | awk -v g="$group" '$2 == g { print $1 }'
}

backend_signal() {
  group=$(group_of_record) || return 0
  kill "-$1" -- "-$group" 2>/dev/null || true
}

backend_release() {
  rm -f "$record"
}
