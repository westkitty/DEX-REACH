#!/bin/zsh
# Build an INTERNAL-USE macOS app bundle from this exact source checkout.
# Does not install, sign, notarize, restart a service, or change any policy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Build requires a Mac with Xcode command-line tools" >&2
  exit 2
fi
swift build -c release --jobs 4 --product DexPanicApp
BIN="$(swift build -c release --jobs 4 --show-bin-path)/DexPanicApp"
APP="$ROOT/dist/DEX Panic.app"
if [[ -e "$APP" ]]; then
  echo "Refusing to overwrite existing bundle: $APP" >&2
  echo "Move it aside manually after preserving your prior build." >&2
  exit 3
fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/DexPanicApp"
chmod 755 "$APP/Contents/MacOS/DexPanicApp"
cp "$ROOT/Packaging/Info.plist" "$APP/Contents/Info.plist"
/usr/bin/plutil -lint "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist"
echo "Built internal unsigned app: $APP"
echo "Not signed, notarized, installed, or runtime-tested by this script."
