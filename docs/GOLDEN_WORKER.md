# DEX//REACH Golden Worker

This is the high-confidence verification path for the primary DEX//REACH deployment. It is deliberately stricter than “the code builds.” A release candidate is not considered proven until source checks, persistent services, the public MCP route, node-local authority, transactional execution, and the Mac launcher all agree.

## What this proves

The golden worker separates and checks these states instead of conflating them:

1. **Repository source** — the intended code and tests are present.
2. **Built output** — TypeScript emits successfully and production dependencies are acceptable.
3. **Installed service definition** — launchd plists are valid and point at the intended repository/runtime.
4. **Running gateway/node** — the persistent processes actually restarted and the node re-registered.
5. **Public MCP surface** — OAuth/PKCE reaches the deployed gateway and all 15 first-class tools are advertised.
6. **Execution path** — compatibility policy, native file/process operations, ADB availability, exact plan→commit, signed receipts, and checkpointing really execute.
7. **Owner authority** — local OFF / READ-ONLY / ON policy remains the final gate; installation and the Dock launcher do not widen it.
8. **Human recovery path** — the Dock icon opens a dedicated DEX//REACH Terminal console from the installed app bundle.

## 1. Establish the repository and policy baseline

```bash
cd "$HOME/DEX-REACH"
git status --short --branch
git remote -v
npm run dex -- policy-check
npm run dex -- status
```

Stop if the repository/branch is not the intended target or `policy-check` fails.

## 2. Deterministic source/build gate

```bash
npm run verify
```

`npm run verify` expands to:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
npm run probe:backend
```

A deprecation warning from the current MCP SDK dependency is non-fatal; any failed command is a release blocker.

## 3. Install/reload the persistent primary services

```bash
npm run install:macos
```

The installer writes and `plutil`-checks both service definitions before changing live processes. It then starts a **separate one-shot LaunchAgent** which waits briefly and replaces the gateway and node outside the request that invoked the installer. This is specifically designed so DEX//REACH can safely install/reload itself.

A brief gateway/node disconnect is expected. After reconnect:

```bash
cat "$HOME/.dex-reach/install-macos.status.json"
launchctl print "gui/$(id -u)/com.stinkyweasel.dex-reach.gateway"
launchctl print "gui/$(id -u)/com.stinkyweasel.dex-reach.node"
npm run dex -- status
```

The install status must be `complete`. The one-shot helper plist deletes itself after completion and must not repeatedly cycle services.

## 4. Run the deployed golden gate

```bash
npm run verify:golden
```

This reruns the deterministic gate and then executes the public OAuth/PKCE smoke. A passing smoke proves the deployed node version and these live paths:

- 15 first-class MCP actions with metadata;
- explicit node discovery and fingerprint;
- exactly 22 remote compatibility tools, with node-owned safety configuration, local call-history/vendor surfaces, and URL proxying withheld;
- isolated compatibility configuration with telemetry disabled and allowed roots enforced;
- ADB executable availability;
- native file write/read roundtrip;
- guarded process execution with DEX/secret-bearing child-environment variables removed;
- exact one-use `reach_plan` → `reach_commit_plan` execution;
- signed receipt visibility for the committed plan;
- reversible Git checkpoint capture.

No attached Android device is required for the ADB-binary proof. Device-control behavior remains a separate hardware check.

## 5. Install and prove the Mac Dock launcher

```bash
npm run install:dock
```

The installer:

- builds `~/Applications/DEX REACH.app`;
- uses a plain local shell executable, not AppleScript Terminal automation;
- generates a local `.command` wrapper containing only the installed Node path and repository console path;
- creates the custom icon;
- ad-hoc signs and verifies the app bundle;
- verifies the exact Dock `persistent-apps` URL;
- opens the app once.

A successful click opens a **new Terminal instance** running `scripts/dex-terminal-console.sh`. The console shows service health and policy and provides:

- refresh/status;
- non-destructive service start/repair;
- immediate AI-access OFF;
- 30-minute READ-ONLY;
- 30-minute ON;
- policy check;
- audit;
- signed receipts;
- grants;
- a DEX CLI prompt.

Opening the launcher must not alter access mode, client ceilings, grants, credentials, roots, or execution profile.

Static bundle checks:

```bash
codesign --verify --deep --strict "$HOME/Applications/DEX REACH.app"
test -x "$HOME/Applications/DEX REACH.app/Contents/MacOS/DEXReachLauncher"
test -x "$HOME/Applications/DEX REACH.app/Contents/Resources/dex-terminal-console.command"
```

## 6. Final repository gate

```bash
git diff --check
git status --short --branch
```

Before commit/push, inspect the complete diff, confirm no credential/state files are tracked, and confirm `README.md` and `OPERATIONAL_STATE.md` describe only evidence actually obtained.

## Stop conditions

Do **not** call the candidate verified if any of these are true:

- policy is missing/corrupt or `policy-check` fails;
- node identity/branch is not the intended target;
- a source/build/audit/probe test fails;
- `install-macos.status.json` is not `complete`;
- the gateway/node does not reconnect;
- deployed node version differs from repository version;
- public smoke fails OAuth resource binding, compatibility-surface restrictions, environment-sanitization proof, or any execution proof;
- ADB reports `available: false`;
- the Dock bundle fails signature/path checks or does not open its own console;
- installation or launcher use changes owner authority without an explicit console action;
- Git contains unreviewed/unexplained changes or secrets.

## Evidence rule

Source presence is implementation evidence, not runtime proof. A command exit code is evidence for that command, not for every downstream state. Prefer the final observable: running service, registered node, public MCP result, signed receipt, installed app, or remote Git branch.
