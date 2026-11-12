#!/bin/zsh
# User-launched local build/install. Does not change remote AI access or services.
set -euo pipefail
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
