# DEX//PANIC 0.2.1 — Stinky Weasel Recovery Control

A **native macOS menu-bar recovery utility** designed to remain responsive when the DEX//REACH gateway, coordinator, node, or ChatGPT connector is inaccessible. First milestone: DEX//REACH only. Hermes, Ollama and other local services are **not** controlled in this release.

## 0.2.1 safety/visibility correction

The status-bar glyph is a **non-template, high-contrast shield**: solid white only when all three required launchd daemons are positively observed running, solid red with an exclamation point when required-service liveness is degraded or unknown. This means **daemon liveness only**. The color does not claim that owner permissions, task outcome, coordinator admission or the network are healthy. See `TESTING.md` for the manual GUI acceptance checklist and controlled-recovery boundaries.

The Big Mac compiled executable was checksum-verified after installing on the MacBook, and the prior v0.2.0 app was retained for rollback. The bundled prebuilt installer now points to the v0.2.1 archive and uses `/bin/mkdir` (macOS) instead of the nonexistent `/usr/bin/mkdir`; it continues to refuse overwriting any existing app.

## What changed in 0.2

**Open Recovery Deck** from the menu bar for a native, keyboard-accessible, dark editorial emergency console. It shows four different kinds of truth separately: launchd service liveness, last manually inspected work admission, last manually inspected owner policy, and **task effects that remain UNVERIFIED**. A flight-recorder timeline displays only local event metadata; it does not reveal stdout, credentials or raw DEX logs. The status-bar menu remains a working emergency fallback even if the larger window is closed.

Recovery safety was materially tightened: the app now requires the **entire canonical required-service roster** before showing all daemons as running, and **re-probes launchd immediately before any start or restart**. The OFF control requests the existing node-local `npm run dex -- disable`, then performs a separate read-only `status` and reports success only when that readback explicitly shows `DISABLED (all remote AI execution refused)`. A timeout or unknown output does not trigger a blind retry. On-demand coordinator inspection recognizes `AVAILABLE` versus `QUEUE` from the actual CLI output, but never treats capacity as permission or as a promise that a future job will run.

This is a safer local control surface, **not** a durable-task reconciler or a general-purpose process killer. Automatic restarts, whole-stack management, login-item enrollment and policy elevation remain absent.

## Safe first-version scope

- Independent AppKit menu-bar application (macOS 13+, Apple Silicon or Intel), no web view, no gateway dependency and no new listener.
- Low-frequency (20-second) local `launchctl print` probes for exact allowlisted services; unknown and absent states are not presented as healthy. Running services are labeled as **liveness only, not proof of execution capacity**.
- On-demand read-only **Inspect coordinator capacity** invokes the existing owner CLI `work-status`; it is not polled in the background and may report unavailable when the CLI is under pressure.
- Owner policy **OFF** through the existing local `npm run dex -- disable` CLI, not by changing private policy files or contacting the gateway.
- Start only positively observed stopped LaunchAgents, without using `kickstart -k`.
- Restart a known running service only after an explicit warning and confirmation. Does not replay tasks, change permissions, clear state or restore ON automatically.
- Bounded private, metadata-only incident log at `~/Library/Logs/DEX-Panic/events.jsonl` (stops appending at 2 MiB rather than deleting old events).
- Launch menu access to the existing read-only Control Room (`http://127.0.0.1:4177`, if already running).
- Does not require Accessibility, Full Disk Access, microphone, screen recording, admin/sudo, or outbound network access.

**Important:** This is a practical first-step recovery control, *not* a full durable-task reconciler or automatic self-healing engine. A timeout can mean an operation completed but lost its response. Never assume a terminated command means its side effects did not occur.

## Install on your MacBook (the low-load route)

The exact v0.2.1 **Apple Silicon bundle** was built on Big Mac, and the resulting binary has been installed and observed running on the MacBook. The verified archive lives at `/Users/bigmac/DEX-Panic-v0.2.1-icon-fix-macos-arm64.app.zip` (ZIP SHA-256 `1157ab28f4f6ce5792f1dbf652e2c6633d1d1a2edb874d415959234f87472cdd`; executable SHA-256 `000ef0fc7554cde33a7a4a78381c2281d7ffbb8223ab902fca2d4beb48bc1050`). The installer now uses macOS's actual `/bin/mkdir` path, fixing v0.2.0's prebuilt-installer failure.

For a **new installation only**, run `Install-Prebuilt-from-BigMac.command` with the owner's SSH alias `westcat`. It authenticates to Big Mac, checks the archive and executable SHA-256, verifies version 0.2.1 and bundle identity, refuses to overwrite an existing `~/Applications/DEX Panic.app`, and requests that macOS open the app. An existing v0.2.0 installation will be left untouched; see `TESTING.md` for a separate, backup-first upgrade and verification policy. To exercise the checksum and extraction path *without installing or launching anything*, run the versioned installer with `--verify-only`. It also accepts a previously downloaded ZIP only after re-verifying its hash and never overwrites the archive.

**Fallback:** if SSH isn't configured, double-click `Install-DEX-Panic.command` to compile locally using Apple's Swift toolchain. Local compilation is heavier and should not be attempted while the MacBook is saturated. Neither installer registers a login item or installs background services. The app is unsigned and unnotarized for internal use only; do not bypass macOS security protections.

**MacBook installation and process launch are verified.** The visible white/red icon, full Recovery Deck interaction, and real policy/service recovery still require owner-observed acceptance; a running PID does not prove the entire GUI works.

## Compile and test on a Mac

```bash
cd "$HOME/DEX-Panic"
swift test
./scripts/build-app.sh
./scripts/verify-app.sh
open "$PWD/dist/DEX Panic.app"
```

Requires Xcode Command Line Tools (`xcode-select --install` if missing). `swift test` also works on Linux to test Foundation-based safety logic; the native menu-bar interface can only compile and run on macOS.

To install without replacing any existing version:

```bash
./scripts/install-local.sh
open "$HOME/Applications/DEX Panic.app"
```

To keep it available after login, add `~/Applications/DEX Panic.app` in macOS **System Settings → General → Login Items**. Installing the app does not silently create a LaunchAgent, change a DEX policy, or configure auto-start.

## Emergency usage

1. Click the shield icon in the menu bar. Choose **Open Recovery Deck** for the four-layer truth display and local black-box history, or use the compact menu directly. Required DEX services appear with `running`, `stopped`, `notInstalled`, or `unknown` states.
2. If services are running but jobs still stall, choose **Inspect coordinator capacity (read-only)**. This can expose CPU/memory pressure, lease pressure and uncoordinated workloads without assuming DEX is healthy.
3. Choose **STOP NEW REMOTE AI EXECUTION** to request the owner-local policy switch to OFF, then verify it through a second owner-local read. The command requires a functioning local DEX checkout and Node/npm; it reports OFF NOT VERIFIED rather than bypassing policy or claiming success when unavailable.
4. Choose **Show owner access status** to read the authoritative CLI output. Do not assume OFF based solely on UI color or a command's exit code.
5. For a stopped service, use **Start stopped service**. For a running service, a restart is a potentially consequential action and requires a separate confirmation.
6. Keep any uncertain active tasks in an unknown/ambiguous state until inspected through the DEX owner CLI; restarting a service does not reconcile task effects.

The app expects a DEX//REACH checkout at `~/DEX-REACH`, including `scripts/dex-reach.ts`, and searches standard Homebrew/npm locations plus NVM/Volta. If your checkout or Node installation differs, `owner status` and `disable` may report unavailable. The menu-bar health scanner works independently of npm. The app never writes DEX private state directly. Resource and policy readouts are valid only for their last explicit inspection, not live subscriptions.

## Security and non-goals

- No `killall`, `pkill`, `sudo`, `rm`, `launchctl bootout` or broad machine reset.
- No automatic ON/enable. The existing node-local OFF/READ-ONLY/ON policy is authoritative.
- No implicit node selection, fallback, new remote endpoint, or policy bypass.
- No automatic retry of an uncertain mutation. No claim that restarting a daemon stops or undoes active external effects.
- Service actions use exact configured labels and argument arrays, not interpolated shell commands.
- Kept within `macos/DEX-Panic/` in the canonical DEX//REACH repo; no changes to DEX runtime, node policy, credentials, or running service configuration.

## Build status

See `OPERATIONAL_STATE.md` for the evidence matrix and `TESTING.md` for operator acceptance steps. Big Mac v0.2.1 compiled, passed 17 tests and bundle checks; the MacBook app was installed and observed running. UI rendering and destructive recovery flows are not yet end-to-end verified. Signing and notarization are not performed.
