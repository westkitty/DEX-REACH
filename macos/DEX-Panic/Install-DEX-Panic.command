#!/bin/zsh
# User-launched local build/install. Does not change remote AI access or services.
set -euo pipefail
if [[ "$(/bin/hostname -s)" != "MacBook-Air" || "$(/usr/bin/id -un)" != "andrew" ]]; then
  /bin/echo "Only the verified MacBook installs the DEX//PANIC menu-bar app. Big Mac is information-only." >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
echo "DEX//PANIC internal build and install"
echo "Target: $HOME/Applications/DEX Panic.app"
echo "This does not edit DEX//REACH, stop/start services, or register a login item."
./scripts/build-app.sh
./scripts/verify-app.sh
./scripts/install-local.sh
open "$HOME/Applications/DEX Panic.app"
echo "DEX//PANIC installed and launch requested. Check the menu bar shield icon."
