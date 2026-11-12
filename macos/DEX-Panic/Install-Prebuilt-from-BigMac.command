#!/bin/zsh
# Owner-triggered MacBook install of the exact Apple Silicon build made on Big Mac.
# Never overrides an existing installation; never contacts the DEX gateway.
set -euo pipefail

TARGET="$HOME/Applications/DEX Panic.app"
ZIP="$HOME/Downloads/DEX-Panic-v0.2.0-final-macos-arm64.app.zip"
REMOTE="westcat:/Users/bigmac/DEX-Panic-v0.2.0-final-macos-arm64.app.zip"
EXPECTED_ZIP="64e67f337097346f76842d3cd19cbb7c4c1605c7ef9c2b26de72471373f0d63f"
EXPECTED_BIN="fb0174daf988b916a56e73711effab75e8b943c8eebd6ca6396b236a60cb81d2"

echo "DEX//PANIC prebuilt Apple Silicon installer"
echo "Source host: westcat (your configured SSH alias for Big Mac)"
echo "Destination: $TARGET"
echo "This does not change DEX access, services, repositories or login items."
if [[ "$(/usr/bin/uname -m)" != "arm64" ]]; then
  echo "Refusing: this prebuilt app requires Apple Silicon (arm64)." >&2
  exit 2
fi
if [[ -e "$TARGET" ]]; then
  echo "Existing installation preserved; no overwrite: $TARGET" >&2
  exit 3
fi
if [[ -e "$ZIP" ]]; then
  echo "Download path already exists. Refusing to overwrite: $ZIP" >&2
  exit 4
fi
/usr/bin/mkdir -p "$HOME/Downloads"
if ! /usr/bin/scp -o BatchMode=yes -o ConnectTimeout=12 "$REMOTE" "$ZIP"; then
  echo "SSH transfer failed. Use Install-DEX-Panic.command to compile locally instead." >&2
  exit 5
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
if [[ "$BUNDLE_VERSION" != "0.2.0" || "$LSUIELEMENT" != "true" ]]; then
  echo "STOP: wrong app version or not a menu-bar application." >&2
  exit 8
fi
ACTUAL_BIN="$(/usr/bin/shasum -a 256 "$SOURCE/Contents/MacOS/DexPanicApp" | /usr/bin/awk '{print $1}')"
if [[ "$ACTUAL_BIN" != "$EXPECTED_BIN" ]]; then
  echo "STOP: executable checksum mismatch." >&2
  exit 9
fi
if [[ -e "$TARGET" ]]; then
  echo "Existing app appeared during staging; refused to replace it." >&2
  exit 10
fi
/usr/bin/mkdir -p "$HOME/Applications"
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
