#!/bin/zsh
# Explicit owner-triggered, checksum-locked v0.2.3 -> v0.3.0 upgrade.
# This never touches DEX//REACH services, node policy, credentials or login items.
set -euo pipefail

if [[ "$(/bin/hostname -s)" != "MacBook-Air" || "$(/usr/bin/id -un)" != "andrew" ]]; then
  /bin/echo "DEX//PANIC: This app installer targets the verified MacBook only; Big Mac is information-only." >&2
  exit 2
fi

TARGET="$HOME/Applications/DEX Panic.app"
ROOT="$HOME/Downloads/DEX-Panic-v0.3.0-upgrade"
BACKUP="$ROOT/DEX Panic-v0.2.3-backup.app"
PREVIOUS="$ROOT/DEX Panic-v0.2.3-preserved.app"
EXTRACT="$ROOT/extracted"
ZIP="$ROOT/DEX-Panic-v0.3.0-macos-arm64.app.zip"
REMOTE="westcat:/Users/bigmac/DEX-Panic-v0.3.0-macos-arm64.app.zip"
EXPECTED_ZIP="cfded298a85907b809074121d0c76b081f7b8d4cdcbef947f9dbe1c9f48ebebc"
EXPECTED_NEW="6ded1cf197b2759982186acd032e7352585555e3ec6edaf4e905df8b219b7137"
EXPECTED_OLD="51502a7a20947d6d67d724710e71cab182a780259700eab56f6f2e58f01a31a5"

say() { /bin/echo "DEX//PANIC: $1"; }
hashbin() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist"; }
bundleid() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"; }

if [[ "$(/usr/bin/uname -m)" != "arm64" ]]; then say "Apple Silicon required."; exit 2; fi
if [[ ! -d "$TARGET" || ! -x "$TARGET/Contents/MacOS/DexPanicApp" ]]; then
  say "Expected installed DEX Panic app not found. Use the fresh installer instead."; exit 3
fi
if [[ "$(version "$TARGET")" == "0.3.0" ]]; then
  [[ "$(hashbin "$TARGET/Contents/MacOS/DexPanicApp")" == "$EXPECTED_NEW" ]] || {
    say "Found v0.3.0 but executable hash differs. Stop."; exit 4
  }
  say "Already installed and verified. No changes needed."; exit 0
fi
if [[ "$(version "$TARGET")" != "0.2.3" ||
      "$(bundleid "$TARGET")" != "com.stinkyweasel.dex-panic" ||
      "$(hashbin "$TARGET/Contents/MacOS/DexPanicApp")" != "$EXPECTED_OLD" ]]; then
  say "Installed app does not match the locked v0.2.3 baseline. Refusing replacement."; exit 5
fi
if [[ -e "$BACKUP" || -e "$PREVIOUS" || -e "$EXTRACT" ]]; then
  say "Upgrade staging already exists. Refusing ambiguous overwrite."; exit 6
fi
/bin/mkdir -p "$ROOT"
if [[ ! -e "$ZIP" ]]; then
  say "Fetching the exact prebuilt v0.3.0 archive from Big Mac..."
  /usr/bin/scp -o BatchMode=yes -o ConnectTimeout=12 "$REMOTE" "$ZIP" || {
    say "SSH transfer failed. Existing app preserved."; exit 7
  }
fi
[[ "$(hashbin "$ZIP")" == "$EXPECTED_ZIP" ]] || {
  say "Archive hash mismatch; no installation attempted."; exit 8
}
if ! /usr/bin/unzip -t "$ZIP" >/dev/null; then
  say "Archive integrity check failed."; exit 9
fi
say "Preserving v0.2.3 and extracting v0.3.0..."
/usr/bin/ditto "$TARGET" "$BACKUP"
[[ "$(hashbin "$BACKUP/Contents/MacOS/DexPanicApp")" == "$EXPECTED_OLD" ]] || {
  say "Backup did not validate; refusing replacement."; exit 10
}
/bin/mkdir -p "$EXTRACT"
/usr/bin/ditto -x -k "$ZIP" "$EXTRACT"
NEW="$EXTRACT/DEX Panic.app"
[[ -x "$NEW/Contents/MacOS/DexPanicApp" &&
   "$(version "$NEW")" == "0.3.0" &&
   "$(bundleid "$NEW")" == "com.stinkyweasel.dex-panic" &&
   "$(hashbin "$NEW/Contents/MacOS/DexPanicApp")" == "$EXPECTED_NEW" ]] || {
  say "New app does not match verified v0.3.0 identity. Existing app preserved."; exit 11
}

# Only terminate the exact currently installed DEX//PANIC executable, never a DEX service.
# Check the full process command, avoiding broad process-name matches.
if ! /usr/bin/python3 - "$TARGET/Contents/MacOS/DexPanicApp" <<'PY'
import os, signal, subprocess, sys, time
target = sys.argv[1]
processes = []
for line in subprocess.check_output(["/bin/ps", "-axo", "pid=,comm="], text=True).splitlines():
    columns = line.strip().split(None, 1)
    if len(columns) == 2 and columns[1] == target:
        processes.append(int(columns[0]))
if len(processes) > 1:
    print("Refusing: multiple DEX PANIC processes match exact executable.", file=sys.stderr)
    sys.exit(2)
if processes:
    pid = processes[0]
    os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        time.sleep(0.1)
        if not any(line.strip().split(None,1)[-1] == target
                   for line in subprocess.check_output(["/bin/ps", "-axo", "pid=,comm="], text=True).splitlines()):
            break
    else:
        print("Refusing replacement: app process still running.", file=sys.stderr)
        sys.exit(3)
PY
then
  say "Could not safely close the old DEX Panic process. Backup retained; app not replaced."; exit 12
fi

/bin/mv "$TARGET" "$PREVIOUS"
if ! /bin/mv "$NEW" "$TARGET"; then
  /bin/mv "$PREVIOUS" "$TARGET"
  say "Upgrade move failed; previous app restored."; exit 13
fi
if [[ "$(hashbin "$TARGET/Contents/MacOS/DexPanicApp")" != "$EXPECTED_NEW" ]]; then
  say "Installed binary did not match. Rolling back."
  /bin/mv "$TARGET" "$ROOT/DEX Panic-v0.3.0-failed.app"
  /bin/mv "$PREVIOUS" "$TARGET"
  /usr/bin/open "$TARGET" || true
  exit 14
fi
/usr/bin/open "$TARGET" || {
  say "Open failed. Previous app preserved at $PREVIOUS; inspect before retrying."; exit 15
}
say "v0.3.0 installed and launch requested. Verify the menu-bar shield and Copy diagnostic report."
say "Rollback preserved at: $BACKUP"
