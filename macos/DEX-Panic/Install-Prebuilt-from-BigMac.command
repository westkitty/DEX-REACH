#!/bin/zsh
# Owner-triggered MacBook install of the exact Apple Silicon build made on Big Mac.
# Never overrides an existing installation; never contacts the DEX gateway.
set -euo pipefail

if [[ "$(/bin/hostname -s)" != "MacBook-Air" || "$(/usr/bin/id -un)" != "andrew" ]]; then
  /bin/echo "Only the verified MacBook installs the DEX//PANIC menu-bar app." >&2
  exit 2
fi

TARGET="$HOME/Applications/DEX Panic.app"
ZIP="$HOME/Downloads/DEX-Panic-v0.3.0-macos-arm64.app.zip"
REMOTE="westcat:/Users/bigmac/DEX-Panic-v0.3.0-macos-arm64.app.zip"
EXPECTED_ZIP="cfded298a85907b809074121d0c76b081f7b8d4cdcbef947f9dbe1c9f48ebebc"
EXPECTED_BIN="6ded1cf197b2759982186acd032e7352585555e3ec6edaf4e905df8b219b7137"

VERIFY_ONLY=0
if [[ $# -eq 1 && "$1" == "--verify-only" ]]; then
  VERIFY_ONLY=1
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--verify-only]" >&2
  exit 2
fi

echo "DEX//PANIC prebuilt Apple Silicon installer"
echo "Source host: westcat (your configured SSH alias for Big Mac)"
echo "Destination: $TARGET"
echo "This does not change DEX access, services, repositories or login items."
if [[ "$(/usr/bin/uname -m)" != "arm64" ]]; then
  echo "Refusing: this prebuilt app requires Apple Silicon (arm64)." >&2
  exit 2
fi
if [[ -e "$TARGET" && "$VERIFY_ONLY" != "1" ]]; then
  echo "Existing installation preserved; no overwrite: $TARGET" >&2
  exit 3
fi
/bin/mkdir -p "$HOME/Downloads"
if [[ -e "$ZIP" ]]; then
  echo "Existing download retained; verifying checksum without overwrite: $ZIP"
else
  if ! /usr/bin/scp -o BatchMode=yes -o ConnectTimeout=12 "$REMOTE" "$ZIP"; then
    echo "SSH transfer failed. Use Install-DEX-Panic.command to compile locally instead." >&2
    exit 5
  fi
fi
ACTUAL_ZIP="$(/usr/bin/shasum -a 256 "$ZIP" | /usr/bin/awk '{print $1}')"
if [[ "$ACTUAL_ZIP" != "$EXPECTED_ZIP" ]]; then
  echo "STOP: archive checksum mismatch. This file will NOT be installed." >&2
  exit 6
fi
STAGE="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp/}dex-panic-install.XXXXXXXX")"
/usr/bin/ditto -x -k "$ZIP" "$STAGE"
SOURCE="$STAGE/DEX Panic.app"
if [[ ! -x "$SOURCE/Contents/MacOS/DexPanicApp" ]]; then
  echo "STOP: extracted application executable missing." >&2
  exit 7
fi
/usr/bin/plutil -lint "$SOURCE/Contents/Info.plist"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SOURCE/Contents/Info.plist")"
if [[ "$BUNDLE_ID" != "com.stinkyweasel.dex-panic" ]]; then
  echo "STOP: unexpected bundle identifier." >&2
  exit 8
fi
BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SOURCE/Contents/Info.plist")"
LSUIELEMENT="$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$SOURCE/Contents/Info.plist")"
if [[ "$BUNDLE_VERSION" != "0.3.0" || "$LSUIELEMENT" != "true" ]]; then
  echo "STOP: wrong app version or not a menu-bar application." >&2
  exit 8
fi
ACTUAL_BIN="$(/usr/bin/shasum -a 256 "$SOURCE/Contents/MacOS/DexPanicApp" | /usr/bin/awk '{print $1}')"
if [[ "$ACTUAL_BIN" != "$EXPECTED_BIN" ]]; then
  echo "STOP: executable checksum mismatch." >&2
  exit 9
fi
if [[ "$VERIFY_ONLY" == "1" ]]; then
  echo "VERIFIED_ONLY: archive, bundle version, executable hash. No app installation or launch."
  exit 0
fi
if [[ -e "$TARGET" ]]; then
  echo "Existing app appeared during staging; refused to replace it." >&2
  exit 10
fi
/bin/mkdir -p "$HOME/Applications"
/usr/bin/ditto "$SOURCE" "$TARGET"
if [[ ! -x "$TARGET/Contents/MacOS/DexPanicApp" ]]; then
  echo "Installation incomplete; check $TARGET" >&2
  exit 11
fi
INSTALLED_BIN="$(/usr/bin/shasum -a 256 "$TARGET/Contents/MacOS/DexPanicApp" | /usr/bin/awk '{print $1}')"
if [[ "$INSTALLED_BIN" != "$EXPECTED_BIN" ]]; then
  echo "STOP: installed executable differs from verified build." >&2
  exit 12
fi
printf 'Installed and verified: %s\n' "$TARGET"
/usr/bin/open "$TARGET"
echo "Open requested. Confirm the shield icon appears in the menu bar."
echo "This is unsigned internal software, not a notarized distribution."
