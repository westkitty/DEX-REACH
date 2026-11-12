#!/bin/zsh
# Install only if target does not exist. Never overwrite a prior app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/DEX Panic.app"
TARGET="$HOME/Applications/DEX Panic.app"
if [[ ! -x "$APP/Contents/MacOS/DexPanicApp" ]]; then
  echo "Build the app first: ./scripts/build-app.sh" >&2
  exit 2
fi
if [[ -e "$TARGET" ]]; then
  echo "Existing app preserved at $TARGET; install refused." >&2
  exit 3
fi
mkdir -p "$HOME/Applications"
/usr/bin/ditto "$APP" "$TARGET"
/usr/bin/plutil -lint "$TARGET/Contents/Info.plist"
if [[ ! -x "$TARGET/Contents/MacOS/DexPanicApp" ]]; then
  echo "Installation is incomplete: executable missing" >&2
  exit 4
fi
echo "Installed local bundle: $TARGET"
echo "Open with: open '$TARGET'"
echo "Startup/login-item configuration is manual and opt-in."
