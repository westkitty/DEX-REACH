# DEX//REACH Terminal Command Reference

Canonical repository: `https://github.com/westkitty/DEX-REACH`

This is a command reference, not one giant script. Run only the section appropriate to the task. Do not run manual and persistent gateway/node modes together unless you deliberately intend separate instances.

## Variables

```bash
REPO_URL="https://github.com/westkitty/DEX-REACH.git"
REPO_DIR="${HOME}/DEX-REACH"
NODE_ID="second-laptop"
NODE_ROOTS="${HOME}/projects"
ENROLLMENT_FILE="/path/to/${NODE_ID}.env"
```

## Prerequisites

```bash
node --version
npm --version
git --version
```

DEX//REACH requires Node.js 22 or newer.

## First clone

```bash
git clone "$REPO_URL" "$REPO_DIR"
cd "$REPO_DIR"
npm ci
```

## Existing checkout — safe update

```bash
cd "$REPO_DIR"
git status --short --branch
git fetch origin
git pull --ff-only origin main
npm ci
```

## Read project authorities

```bash
cd "$REPO_DIR"
sed -n '1,460p' README.md
sed -n '1,360p' OPERATIONAL_STATE.md
sed -n '1,260p' SECURITY.md
```

## Fresh local bootstrap

```bash
cd "$REPO_DIR"
npm run bootstrap -- --public-url http://127.0.0.1:8787
```

Existing `~/.dex-reach/secrets.env` credentials are preserved rather than overwritten.

## Externally reachable gateway bootstrap

Use the authenticated HTTPS gateway in front of the localhost-bound service. Do not place tokens or credentials in the command.

```bash
cd "$REPO_DIR"
npm run bootstrap -- --public-url "https://YOUR-HTTPS-GATEWAY"
```

## Manual development mode

Terminal 1:

```bash
cd "$REPO_DIR"
npm run gateway
```

Terminal 2:

```bash
cd "$REPO_DIR"
npm run node
```

Terminal 3:

```bash
cd "$REPO_DIR"
npm run smoke
```

## Persistent primary macOS install / safe reload

```bash
cd "$REPO_DIR"
npm run install:macos
```

The command stages and validates both LaunchAgents, then delegates the actual gateway/node replacement to a separate one-shot launchd helper so a DEX-hosted install can return before replacing its own transport.

After the expected brief reconnect:

```bash
cat "${HOME}/.dex-reach/install-macos.status.json"
npm run dex -- status
```

The status file must end in `"state": "complete"`.

## macOS Dock control terminal

```bash
cd "$REPO_DIR"
npm run install:dock
```

This installs and pins `~/Applications/DEX REACH.app`. Clicking the icon opens a new Terminal instance with the DEX//REACH control console. Launching it does not change AI-access authority by itself.

## macOS service status

```bash
launchctl print "gui/$(id -u)/com.stinkyweasel.dex-reach.gateway"
launchctl print "gui/$(id -u)/com.stinkyweasel.dex-reach.node"
```

## Persistent service update/restart

Preferred path:

```bash
cd "$REPO_DIR"
npm run install:macos
```

For a deliberate forced restart from a **local human-controlled Terminal**, not from the DEX request being restarted:

```bash
launchctl kickstart -k "gui/$(id -u)/com.stinkyweasel.dex-reach.gateway"
launchctl kickstart -k "gui/$(id -u)/com.stinkyweasel.dex-reach.node"
```

A remote request that kills its own gateway/node transport can lose its response even if the service later recovers. Use `install:macos` for self-hosted updates.

## macOS service logs

```bash
tail -f "${HOME}/.dex-reach/logs/com.stinkyweasel.dex-reach.gateway.log"
```

Other logs when needed:

```bash
tail -f "${HOME}/.dex-reach/logs/com.stinkyweasel.dex-reach.gateway.err.log"
tail -f "${HOME}/.dex-reach/logs/com.stinkyweasel.dex-reach.node.log"
tail -f "${HOME}/.dex-reach/logs/com.stinkyweasel.dex-reach.node.err.log"
```

## Local node status and immediate kill switch

```bash
cd "$REPO_DIR"
npm run dex -- status
npm run dex -- disable
```

## Temporary access

```bash
npm run dex -- read-only --for 30m
npm run dex -- read-only --for 2h
npm run dex -- enable --for 30m
npm run dex -- enable --for 1h
```

## Persistent access mode

```bash
npm run dex -- enable
npm run dex -- read-only
npm run dex -- disable
```

## Per-client ceilings

```bash
npm run dex -- client chatgpt off
npm run dex -- client claude read-only
npm run dex -- client chatgpt default
npm run dex -- client claude default
```

A client ceiling can only reduce the node's current authority.

## Policy validation

```bash
npm run dex -- policy-check
```

## Audit

```bash
npm run dex -- audit --limit 50
npm run dex -- audit --client chatgpt
npm run dex -- audit --client claude
```

## Signed execution receipts

```bash
npm run dex -- receipts --limit 20
```

## Capability grants

```bash
npm run dex -- grant chatgpt file.write --root "$HOME/projects" --for 20m --max-uses 6
npm run dex -- grants
npm run dex -- explain chatgpt dex.file.write --path "$HOME/projects/example.txt"
npm run dex -- grant-clear chatgpt
```

Supported capability names: `inspect`, `file.read`, `file.write`, `checkpoint`, `process.shell`, `compat`.

## Primary validation gates

Deterministic source/build gate:

```bash
cd "$REPO_DIR"
npm run verify
```

Full deployed golden-worker gate:

```bash
cd "$REPO_DIR"
npm run verify:golden
```

Equivalent individual commands:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
npm run probe:backend
npm run smoke
```

See `docs/GOLDEN_WORKER.md` for the persistent-install and Dock-launcher proof around these commands.

## List enrolled nodes — gateway owner

```bash
npm run nodes -- list
```

## Enroll a second device — gateway owner

```bash
npm run nodes -- enroll "$NODE_ID" \
  --profile development \
  --roots "$NODE_ROOTS"
```

The generated enrollment file contains a private credential. Transfer it through a private channel. Do not put it in Git, issues, prompts, ordinary chat, email, or public paste services.

## Enroll with an explicit output file

```bash
npm run nodes -- enroll "$NODE_ID" \
  --profile development \
  --roots "$NODE_ROOTS" \
  --output "${HOME}/.dex-reach/nodes/${NODE_ID}.env"
```

## Second device — clone and install

```bash
git clone "$REPO_URL" "$REPO_DIR"
cd "$REPO_DIR"
npm ci
npm run install:node -- \
  --env "$ENROLLMENT_FILE" \
  --roots "$NODE_ROOTS" \
  --service
npm run dex -- status
```

Newly enrolled nodes start OFF.

On macOS, `install:node --service` stages and validates the node LaunchAgent, then uses a one-shot helper for replacement so an already-running DEX node does not have to kill the request performing its own update. Non-loopback node gateway URLs must use `wss://`; loopback `ws://` remains valid for local development.

## Second device — manual node mode

Use instead of `--service` when deliberately running manually:

```bash
LOCAL_NODE_ENV="${HOME}/.dex-reach/nodes/${NODE_ID}.env"
DEX_REACH_ENV_FILE="$LOCAL_NODE_ENV" npm run node
```

## Second device — safe first access

```bash
npm run dex -- status
npm run dex -- read-only --for 30m
# When explicitly ready for configured write/process access:
npm run dex -- enable --for 30m
# Immediate local kill switch:
npm run dex -- disable
```

## Multiple local node credentials

```bash
npm run dex -- status --node "$NODE_ID"
npm run dex -- read-only --for 30m --node "$NODE_ID"
npm run dex -- disable --node "$NODE_ID"
```

## Rotate a node credential — gateway owner

```bash
npm run nodes -- rotate "$NODE_ID" --grace-seconds 600
```

## Revoke a node — deliberate security action

```bash
npm run nodes -- revoke "$NODE_ID"
```

Revocation is a security action, not a troubleshooting shortcut.

## Forget a previously revoked node

```bash
npm run nodes -- forget "$NODE_ID"
```

`forget` removes the gateway-side revoked-node record. Do not use it as a substitute for revoke.

## Second-device local uninstall

Preserve local credential/policy state:

```bash
npm run dex -- uninstall
```

Deliberate local-state purge:

```bash
npm run dex -- uninstall --purge-state --yes-delete-state
```

## Primary macOS service uninstall

```bash
npm run uninstall:macos
```

## Safe Git inspection before changes

```bash
cd "$REPO_DIR"
git status --short --branch
git remote -v
git log -10 --oneline --decorate
```

## Inspect changes before commit

```bash
git status --short
git diff
git diff --cached
```

## Normal authorized commit / push

Only after reviewing the changed files and validation evidence:

```bash
git add <INTENDED-FILES>
git diff --cached
git commit -m "describe the verified DEX//REACH change"
git push origin main
```

Never force-push DEX//REACH as a routine repair step.

## Fast everyday primary-Mac check

```bash
cd "$REPO_DIR"
git status --short --branch
npm run dex -- status
npm run typecheck
npm test
```

## Full high-confidence check

```bash
cd "$REPO_DIR"
git status --short --branch
npm run dex -- status
npm run verify:golden
git status --short --branch
```
