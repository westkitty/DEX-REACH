#!/bin/zsh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${DEX_REACH_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
DEX="$ROOT/dist/scripts/dex-reach.js"
DOMAIN="gui/$(/usr/bin/id -u)"
GATEWAY_LABEL="com.stinkyweasel.dex-reach.gateway"
NODE_LABEL="com.stinkyweasel.dex-reach.node"
AGENTS="$HOME/Library/LaunchAgents"

printf '\033]0;DEX//REACH Control Terminal\007'

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "DEX//REACH: Node.js was not found."
  read -k 1 "?Press any key to close..."
  exit 1
fi
if [[ ! -f "$DEX" ]]; then
  echo "DEX//REACH: compiled CLI is missing at $DEX"
  echo "Run npm run build from $ROOT, then reopen this launcher."
  read -k 1 "?Press any key to close..."
  exit 1
fi

run_dex() {
  "$NODE_BIN" "$DEX" "$@"
}

pause() {
  echo
  read -k 1 "?Press any key to return to DEX//REACH..."
}

ensure_service() {
  local label="$1"
  local target="$DOMAIN/$label"
  local plist="$AGENTS/$label.plist"

  if /bin/launchctl kickstart "$target" >/dev/null 2>&1; then
    return 0
  fi
  if [[ ! -f "$plist" ]]; then
    echo "Missing LaunchAgent: $plist"
    return 1
  fi
  /bin/launchctl bootstrap "$DOMAIN" "$plist" >/dev/null 2>&1 || true
  /bin/launchctl enable "$target" >/dev/null 2>&1 || true
  /bin/launchctl kickstart "$target" >/dev/null 2>&1
}

ensure_services() {
  ensure_service "$GATEWAY_LABEL" || return 1
  ensure_service "$NODE_LABEL" || return 1
}

service_line() {
  local label="$1"
  if /bin/launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    echo "  ${label##*.}: launchd loaded"
  else
    echo "  ${label##*.}: NOT loaded"
  fi
}

# Preserve the old one-click recovery behavior without changing owner authority. This never uses
# kickstart -k and never changes OFF / READ-ONLY / ON, grants, roots, credentials, or profiles.
STARTUP_NOTE="services available"
if ! ensure_services; then
  STARTUP_NOTE="service recovery needs attention; use option 2 for details"
fi

while true; do
  clear
  print -P '%F{red}DEX//REACH%f — MacBook Control Terminal'
  echo '================================================'
  echo "$STARTUP_NOTE"
  service_line "$GATEWAY_LABEL"
  service_line "$NODE_LABEL"
  if /usr/bin/curl -fsS --max-time 1 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    echo '  gateway health: responding'
  else
    echo '  gateway health: unavailable'
  fi
  echo
  run_dex status || true
  echo
  echo '1  Refresh status'
  echo '2  Start/repair installed DEX services'
  echo '3  AI access OFF (kill switch)'
  echo '4  READ-ONLY for 30 minutes'
  echo '5  ON for 30 minutes'
  echo '6  Policy check'
  echo '7  Recent audit (20)'
  echo '8  Signed receipts (20)'
  echo '9  Capability grants'
  echo 'A  Live DEX activity'
  echo 'D  DEX command prompt'
  echo '0  Close this window'
  echo
  read "choice?Choose: "
  case "$choice" in
    1) ;;
    2)
      echo
      if ensure_services; then
        STARTUP_NOTE="services available"
        echo 'Installed DEX services are loaded. AI-access policy was not changed.'
      else
        STARTUP_NOTE="service recovery failed"
        echo 'Could not restore one or more installed services.'
      fi
      pause
      ;;
    3) run_dex disable; pause ;;
    4) run_dex read-only --for 30m; pause ;;
    5) run_dex enable --for 30m; pause ;;
    6) run_dex policy-check; pause ;;
    7) run_dex audit --limit 20; pause ;;
    8) run_dex receipts --limit 20; pause ;;
    9) run_dex grants; pause ;;
    a|A) run_dex activity; pause ;;
    d|D)
      echo
      echo 'Enter arguments after "dex" (examples: status, audit --limit 50, explain chatgpt dex.file.write --path /tmp/x).'
      echo 'Blank line returns to the menu. This prompt invokes only the DEX local CLI; it is not a raw shell.'
      while true; do
        read "line?dex> "
        [[ -z "$line" ]] && break
        args=(${(z)line})
        run_dex "${args[@]}"
      done
      ;;
    0) exit 0 ;;
    *) echo "Unknown choice: $choice"; pause ;;
  esac
done
