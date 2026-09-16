#!/bin/zsh
set -u

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMAND_FILE="$APP_ROOT/Resources/dex-terminal-console.command"

if [[ ! -x "$COMMAND_FILE" ]]; then
  /usr/bin/logger -t DEX-REACH "launcher bundle is missing executable console command: $COMMAND_FILE"
  exit 1
fi

# -n gives DEX//REACH its own Terminal application instance/window without Apple Events or TCC
# automation permission. The command file contains only local paths prepared by install:dock.
exec /usr/bin/open -na Terminal "$COMMAND_FILE"
