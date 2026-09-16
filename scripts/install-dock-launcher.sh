#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER_SOURCE="$ROOT/macos/DEXReachLauncher.sh"
ICON_SOURCE="$ROOT/macos/DEXReachLauncherIcon.swift"
CONSOLE="$ROOT/scripts/dex-terminal-console.sh"
APP_DIR="$HOME/Applications"
APP_NAME="DEX REACH.app"
FINAL_APP="$APP_DIR/$APP_NAME"
TMP_DIR="$(mktemp -d /tmp/dex-reach-launcher.XXXXXX)"
NEW_APP="$TMP_DIR/$APP_NAME"
MASTER_PNG="$TMP_DIR/AppIcon-1024.png"
ICONSET="$TMP_DIR/AppIcon.iconset"
NODE_BIN="$(command -v node 2>/dev/null || true)"

cleanup() { /bin/rm -R "$TMP_DIR"; }
trap cleanup EXIT

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "ERROR: a working Node.js binary is required to install the DEX//REACH launcher." >&2
  exit 1
fi
VERSION="$(cd "$ROOT" && "$NODE_BIN" -p "require('./package.json').version")"
BUILD_NUMBER="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
if [[ ! -f "$LAUNCHER_SOURCE" || ! -f "$ICON_SOURCE" || ! -f "$CONSOLE" ]]; then
  echo "ERROR: DEX//REACH launcher source files are incomplete." >&2
  exit 1
fi

mkdir -p "$APP_DIR" "$NEW_APP/Contents/MacOS" "$NEW_APP/Contents/Resources" "$ICONSET"
/bin/chmod 755 "$CONSOLE"
/bin/cp "$LAUNCHER_SOURCE" "$NEW_APP/Contents/MacOS/DEXReachLauncher"
/bin/chmod 755 "$NEW_APP/Contents/MacOS/DEXReachLauncher"

/usr/bin/xcrun swift "$ICON_SOURCE" "$MASTER_PNG"
/usr/bin/sips -z 16 16 "$MASTER_PNG" --out "$ICONSET/icon_16x16.png" >/dev/null
/usr/bin/sips -z 32 32 "$MASTER_PNG" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
/usr/bin/sips -z 32 32 "$MASTER_PNG" --out "$ICONSET/icon_32x32.png" >/dev/null
/usr/bin/sips -z 64 64 "$MASTER_PNG" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
/usr/bin/sips -z 128 128 "$MASTER_PNG" --out "$ICONSET/icon_128x128.png" >/dev/null
/usr/bin/sips -z 256 256 "$MASTER_PNG" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
/usr/bin/sips -z 256 256 "$MASTER_PNG" --out "$ICONSET/icon_256x256.png" >/dev/null
/usr/bin/sips -z 512 512 "$MASTER_PNG" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
/usr/bin/sips -z 512 512 "$MASTER_PNG" --out "$ICONSET/icon_512x512.png" >/dev/null
/bin/cp "$MASTER_PNG" "$ICONSET/icon_512x512@2x.png"
/usr/bin/iconutil -c icns "$ICONSET" -o "$NEW_APP/Contents/Resources/AppIcon.icns"

WRAPPER="$NEW_APP/Contents/Resources/dex-terminal-console.command"
DEX_CONSOLE="$CONSOLE" DEX_NODE_BIN="$NODE_BIN" DEX_WRAPPER="$WRAPPER" /usr/bin/python3 - <<'PY'
import os
from pathlib import Path

def shq(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"

wrapper = "\n".join([
    "#!/bin/zsh",
    "export DEX_REACH_NODE_BIN=" + shq(os.environ['DEX_NODE_BIN']),
    "exec /bin/zsh " + shq(os.environ['DEX_CONSOLE']),
    ""
])
Path(os.environ['DEX_WRAPPER']).write_text(wrapper)
PY
/bin/chmod 755 "$WRAPPER"

cat > "$NEW_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>DEX//REACH</string>
<key>CFBundleExecutable</key><string>DEXReachLauncher</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleIdentifier</key><string>com.stinkyweasel.dex-reach.launcher</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>DEX REACH</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

/usr/bin/plutil -replace CFBundleShortVersionString -string "$VERSION" "$NEW_APP/Contents/Info.plist"
/usr/bin/plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$NEW_APP/Contents/Info.plist"
/usr/bin/plutil -lint "$NEW_APP/Contents/Info.plist" >/dev/null
/usr/bin/codesign --force --deep --sign - "$NEW_APP" >/dev/null
/usr/bin/codesign --verify --deep --strict "$NEW_APP"

if [[ -e "$FINAL_APP" ]]; then
  BACKUP="$APP_DIR/DEX REACH backup $(/bin/date +%Y%m%d-%H%M%S).app"
  /usr/bin/ditto "$FINAL_APP" "$BACKUP"
  echo "Previous launcher copied to: $BACKUP"
  FINAL_APP_PATH="$FINAL_APP" /usr/bin/python3 - <<'PY'
import os, shutil
path = os.environ['FINAL_APP_PATH']
if os.path.isdir(path):
    shutil.rmtree(path)
elif os.path.exists(path):
    os.unlink(path)
PY
fi
/bin/mv "$NEW_APP" "$FINAL_APP"

/usr/bin/touch "$FINAL_APP"
APP_URL="file://${FINAL_APP// /%20}/"

DOCK_HAS_APP="$(APP_URL="$APP_URL" python3 - <<'PY'
import os, pathlib, plistlib
p = pathlib.Path.home() / "Library/Preferences/com.apple.dock.plist"
target = os.environ["APP_URL"]
try:
    with p.open("rb") as f:
        dock = plistlib.load(f)
except Exception:
    print("no")
    raise SystemExit
for item in dock.get("persistent-apps", []):
    url = item.get("tile-data", {}).get("file-data", {}).get("_CFURLString", "")
    if url == target:
        print("yes")
        break
else:
    print("no")
PY
)"

if [[ "$DOCK_HAS_APP" != "yes" ]]; then
  /usr/bin/defaults write com.apple.dock persistent-apps -array-add "{\"tile-data\"={\"file-data\"={\"_CFURLString\"=\"$APP_URL\";\"_CFURLStringType\"=15;};\"file-label\"=\"DEX//REACH\";};\"tile-type\"=\"file-tile\";}"
fi

/usr/bin/killall Dock >/dev/null 2>&1 || true
/bin/sleep 2

DOCK_VERIFY="$(APP_URL="$APP_URL" python3 - <<'PY'
import os, pathlib, plistlib
p = pathlib.Path.home() / "Library/Preferences/com.apple.dock.plist"
target = os.environ["APP_URL"]
with p.open("rb") as f:
    dock = plistlib.load(f)
matches = []
for i, item in enumerate(dock.get("persistent-apps", [])):
    td = item.get("tile-data", {})
    url = td.get("file-data", {}).get("_CFURLString", "")
    if url == target:
        matches.append((i, td.get("file-label", ""), url))
if not matches:
    raise SystemExit(1)
for i, label, url in matches:
    print(f"{i}\t{label}\t{url}")
PY
)" || {
  echo "ERROR: DEX//REACH app was built but the exact Dock tile could not be verified." >&2
  exit 1
}

/usr/bin/codesign --verify --deep --strict "$FINAL_APP"
/bin/test -x "$FINAL_APP/Contents/MacOS/DEXReachLauncher"
/bin/test -s "$FINAL_APP/Contents/Resources/AppIcon.icns"
/bin/test -x "$FINAL_APP/Contents/Resources/dex-terminal-console.command"
/usr/bin/open -n "$FINAL_APP"

echo "Installed launcher: $FINAL_APP"
echo "Verified Dock tile: $DOCK_VERIFY"
echo "Clicking DEX//REACH opens a new Terminal instance running the local DEX control console."
echo "Launching the console never changes AI-access authority by itself."
