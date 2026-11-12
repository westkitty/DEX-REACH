#!/bin/bash
# Owner-only macOS login agent for the read-only DEX Control Room.
set -euo pipefail
LABEL=com.stinkyweasel.dex-control-room
PORT=4177
ROOT="$(cd "$(dirname "$0")/.." && /bin/pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=/opt/homebrew/opt/node/bin/node
LOGS="$HOME/Library/Logs/StinkyWeaselControl"
DOMAIN="gui/$(/usr/bin/id -u)"
MODE=install
if [[ $# -gt 0 ]]; then MODE="$1"; fi
if [[ "$MODE" != install && "$MODE" != --refresh && "$MODE" != --print-plist ]]; then
  echo "Usage: $0 [--refresh|--print-plist]" >&2; exit 2
fi

render_plist() {
  /bin/cat <<PLIST_XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array>
<string>$NODE</string><string>--import</string><string>tsx</string>
<string>$ROOT/scripts/control-room.ts</string>
</array>
<key>WorkingDirectory</key><string>$ROOT</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
<key>DEX_REACH_STATE_DIR</key><string>$HOME/.dex-reach</string>
<key>DEX_CONTROL_PORT</key><string>$PORT</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>Nice</key><integer>5</integer>
<key>StandardOutPath</key><string>$LOGS/server.out.log</string>
<key>StandardErrorPath</key><string>$LOGS/server.err.log</string>
</dict></plist>
PLIST_XML
}
if [[ "$MODE" == --print-plist ]]; then render_plist; exit 0; fi
if [[ "$(/bin/hostname -s)" != MacBook-Air ||
      "$(/usr/bin/id -un)" != andrew || "$HOME" != /Users/andrew ]]; then
  echo "STOP: only the verified MacBook owner may install this login service." >&2
  exit 3
fi
if [[ ! "$ROOT" =~ ^/Users/andrew/[A-Za-z0-9._/-]+$ ]]; then
  echo "STOP: unverified or unsafe source path." >&2; exit 4
fi
if [[ ! -x "$NODE" || ! -f "$ROOT/scripts/control-room.ts" ||
      ! -f "$ROOT/src/shared/control-room-share.ts" ||
      ! -f "$ROOT/control-room/index.html" ||
      ! -f "$ROOT/node_modules/tsx/package.json" ]]; then
  echo "STOP: complete source, Node or tsx dependency missing." >&2; exit 5
fi
REMOTE="$(/usr/bin/git -C "$ROOT" remote get-url origin)"
if [[ "$REMOTE" != git@github.com:westkitty/DEX-REACH.git &&
      "$REMOTE" != https://github.com/westkitty/DEX-REACH.git ]]; then
  echo "STOP: source repository is not westkitty/DEX-REACH." >&2; exit 6
fi
/bin/mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"
TEMP="$(/usr/bin/mktemp "$HOME/Library/LaunchAgents/.dex-control-room.XXXXXX")"
trap '/bin/rm -f "$TEMP"' EXIT
render_plist > "$TEMP"
/usr/bin/plutil -lint "$TEMP" >/dev/null
if [[ -f "$PLIST" ]]; then /usr/bin/plutil -lint "$PLIST" >/dev/null; fi
is_ours() {
  /usr/bin/curl --noproxy '*' --connect-timeout 1 --max-time 3 -fsS \
    "http://127.0.0.1:$PORT/" 2>/dev/null | /usr/bin/grep -Fq 'STINKY WEASEL CONTROL'
}
loaded() { /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
if /usr/bin/nc -G 1 -z 127.0.0.1 "$PORT" >/dev/null 2>&1 && ! is_ours; then
  echo "STOP: port 4177 occupied by an unverified listener. No change made." >&2; exit 7
fi
if [[ -f "$PLIST" ]] && /usr/bin/cmp -s "$TEMP" "$PLIST" &&
   "$MODE" != --refresh ]] && loaded && is_ours; then
  echo "PASS: login agent already serving; no restart necessary."; exit 0
fi
BACKUP=""
if [[ -f "$PLIST" ]] && ! /usr/bin/cmp -s "$TEMP" "$PLIST"; then
  BACKUP="$PLIST.backup.$(/bin/date -u +%Y%m%dT%H%M%SZ)"
  /bin/cp -p "$PLIST" "$BACKUP"
fi
if loaded; then /bin/launchctl bootout "$DOMAIN/$LABEL"; fi
if [[ ! -f "$PLIST" ]] || ! /usr/bin/cmp -s "$TEMP" "$PLIST"; then
  /bin/cp "$TEMP" "$PLIST"; /bin/chmod 644 "$PLIST"
fi
if ! /bin/launchctl bootstrap "$DOMAIN" "$PLIST"; then
  echo "ERROR: launch agent bootstrap failed." >&2
  if [[ -n "$BACKUP" ]]; then
    /bin/cp -p "$BACKUP" "$PLIST"
    /bin/launchctl bootstrap "$DOMAIN" "$PLIST" || true
  fi
  exit 8
fi
OK=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if is_ours; then OK=1; break; fi
  /bin/sleep 1
done
if [[ "$OK" != 1 ]] || ! loaded; then
  echo "ERROR: dashboard not ready. Check $LOGS/server.err.log." >&2; exit 9
fi
echo "PASS: Control Room is serving at http://127.0.0.1:4177"
echo "PASS: macOS RunAtLoad/KeepAlive login agent loaded."
echo "NOTE: next-login behavior requires a future real logout/login to verify."
