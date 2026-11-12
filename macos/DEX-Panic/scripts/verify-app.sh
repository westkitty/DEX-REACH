#!/bin/zsh
set -euo pipefail
APP="${1:-$(cd "$(dirname "$0")/.." && pwd)/dist/DEX Panic.app}"
test -d "$APP/Contents"
test -x "$APP/Contents/MacOS/DexPanicApp"
/usr/bin/plutil -lint "$APP/Contents/Info.plist"
BID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
UI="$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$APP/Contents/Info.plist")"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[[ "$BID" == "com.stinkyweasel.dex-panic" ]]
[[ "$UI" == "true" ]]
[[ "$VERSION" == "0.2.0" ]]
/usr/bin/file "$APP/Contents/MacOS/DexPanicApp"
/usr/bin/shasum -a 256 "$APP/Contents/MacOS/DexPanicApp"
echo "Bundle metadata and executable checked. Runtime, signing, and notarization are separate gates."
