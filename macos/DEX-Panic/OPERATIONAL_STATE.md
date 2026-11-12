# DEX//PANIC Operational State

Updated: 2026-11-12 (America/Detroit)

## Purpose and authority
MacBook-local emergency control independent of the DEX//REACH gateway. Device owner retains final execution and policy authority. This is a standalone Swift app, not a source or runtime modification to the canonical `westkitty/DEX-REACH` repository.

## Implemented v0.1.0
- AppKit status-bar UI with a 20-second local `launchctl print` probe of three required DEX services (gateway, node, coordinator) and the optional worker.
- Health wording reports **service liveness only**. Running services do not imply that coordinator admission, task execution, or the gateway is healthy. A manual read-only `work-status` action inspects capacity and uncoordinated workloads.
- Explicit local OFF control invokes existing owner CLI `npm run dex -- disable`; no direct policy edit, no automatic ON, no remote gateway dependency for policy setting.
- A stopped known launchd service can be started; an observed running one may be restarted only with owner confirmation and an ambiguous-task-effects warning. Unknown/not-installed status refuses these actions.
- Private metadata-only incident log bounded to 2 MiB; links to existing read-only Stinky Weasel Control.
- Internal unsigned macOS `.app` build and opt-in local installer; separate opt-in SSH prebuilt fetch installer if `westcat` is configured. Neither installs a login item automatically.
- Hermes, Ollama, whole-stack pressure analysis and automatic recovery remain future milestones, NOT implemented.

## Directly observed validation
- Local Linux Swift 6.2 `swift test`: **9/9 PASS** after capacity-inspector change. macOS UI source parsing: PASS.
- Big Mac (`bigmac`, arm64, Swift 6.4): `swift test --jobs 4` **9/9 PASS** on revised source.
- Big Mac: `scripts/build-app.sh` **PASS**, `scripts/verify-app.sh` **PASS**, bundle ID `com.stinkyweasel.dex-panic`, `LSUIElement=true`, app executable Mach-O arm64. Revised binary SHA-256 `6f3b0b5cb097963326dab29f569256018605d800f5c344e00e72202399c54686`.
- Revised compiled artifact: `/Users/bigmac/DEX-Panic-v0.1.0-macos-arm64-capacity.app.zip`, SHA-256 `c95646d967d67478e9bf90ae6952c937b02adbd65fcbfa3f4dabf08740ff2516` (85,453 bytes). Not uploaded or published externally.
- Test scope: parser, liveness transitions, required/unknown health, safe start vs confirmed restart, timeout, incident logging. Manual coordinator-capacity status UI was compiled but was not runtime-operated against a local Mac session.

## Not verified / blocked
- **MacBook installation NOT PERFORMED.** MacBook node was intermittently disconnected and its execution coordinator refused new work under CPU/memory and competing-workload pressure; later HTTP request for a whole Base64 artifact was refused with 413. No partial transfer was accepted or installed. App not launched on MacBook or Big Mac.
- Menu rendering, macOS login item, notification behavior, actual live `launchctl` UI probes, owner disable effects, service restart effectiveness, and recovery after real daemon crashes: NOT TESTED.
- Code signing, notarization, Gatekeeper distribution: NOT PERFORMED (private internal unsigned build).
- Automatic self-healing, durable task reconciliation, authorization for force termination and whole-stack integrations: NOT IMPLEMENTED. No claim of actual fix to underlying DEX coordinator, transport or task reliability.
- Canonical MacBook repo had unrelated modifications and was 8 commits behind origin when inspected. Intentionally not edited, reset, committed or pushed.
- No policy change, service restart, installation, login item, authorization widening or destructive action was executed on MacBook or Big Mac by this creation workflow.

## Protected invariants
- Node is final execution authority; all remote operations require exact node ID; app does not grant or widen authority.
- No `killall`, `pkill`, broad machine reset, `sudo`, automatic force restart or implicit node fallback.
- Never retry uncertain external mutations blindly. Restarting a daemon does not prove a task stopped.
- Preserve previous source and installations; installers refuse overwrites.
- Source archive is the user-deliverable. The verified native artifact remains on Big Mac until explicitly transferred and verified on MacBook.

## Next acceptance gates
1. Transfer prebuilt ZIP over known-owner authenticated SSH (or build locally) after checking capacity and ownership. Confirm archive hash, executable hash and exact bundle ID before installing.
2. Launch from `~/Applications/DEX Panic.app` on the MacBook; verify a shield menu-bar icon, no Dock icon, responsive menu and no existing app overwritten.
3. Compare live launchctl states with known-owner CLI, then use manual read-only work-status to observe actual coordinator admission pressure.
4. Verify owner policy OFF only if the device owner intentionally chooses to disable new AI execution; inspect policy afterward, never silently return ON.
5. If an isolated noncritical launchd fixture is available, test stopped-start and confirmation flows without interrupting live DEX tasks.

## 2026-11-12 — DEX//PANIC v0.2 uplift (candidate; scope-isolated)

Goal: improve emergency usability and close concrete failure-path defects while preserving v0.1 and leaving DEX//REACH, its access policy, the installed services, and active tasks alone.

Implemented in an isolated v0.2 source copy:
- Native Recovery Deck (SwiftUI hosted by the independent AppKit menu-bar controller) with four evidence layers, four allowlisted services, an owner-only OFF control, manual policy/admission inspection, and a bounded local event timeline.
- Required-service health now fails closed for partial or duplicate required observations; any confirmed stopped required service is surfaced as a fault.
- Starts/restarts re-probe immediately before launchctl action. A changed/unknown state refuses instead of relying on the cached menu observation; only exact allowlisted service IDs/labels are actionable.
- Incident tail reads at most 96 KiB; log refuses symlink event targets and new entries exceeding 2 MiB rather than silently discarding evidence.
- OFF reports `VERIFIED` only if a separate read-only owner CLI status parses exactly one `AI access: DISABLED (all remote AI execution refused)` field. Unknown/timeout leaves OFF unverified and is never blindly retried.
- Coordinator-capacity readback parses actual `AVAILABLE`/`QUEUE` output but is explicitly *last inspected*, not a continuously live admission guarantee.
- Product Bible added; bundle version raised to `0.2.0` without changing the existing bundle ID or install behavior.

Validation status: local Linux `swift test` 16/16 PASS after core changes. Apple Silicon debug compile PASS for the first Recovery Deck revision. **Final macOS v0.2 build, tests, packaging, launch and MacBook installation remain pending until their separate proof is obtained.** Git/CI/commit/push are not applicable to this standalone, unversioned source copy and are not claimed. Prior Big Mac v0.1 source and binaries were not overwritten. No DEX policy, service or task mutation occurred.

### v0.2 release verification addendum (after final candidate)
- `swift test --jobs 4` on **Big Mac**, arm64 Swift 6.4: **16/16 PASS** against the final v0.2 source, November 12, 2026. Local Linux Swift 6.2: **16/16 PASS**.
- `scripts/build-app.sh` compiled the v0.2 executable in an isolated `/Users/bigmac/DEX-Panic-Uplift-0.2` source directory, leaving original v0.1 untouched. `scripts/verify-app.sh`: PASS. Bundle ID `com.stinkyweasel.dex-panic`, CFBundleShortVersionString `0.2.0`, CFBundleVersion `2`, `LSUIElement=true`, Mach-O arm64 executable SHA-256 `3b4eb550ee4ca7bbb581dafa66940ff9ad12fedd924e314fd6a5ddffc3d49d2a`.
- Compiled app ZIP on Big Mac: `/Users/bigmac/DEX-Panic-v0.2.0-macos-arm64.app.zip`, 188,099 bytes, SHA-256 `3f15b208f483f8fd69854dcf5255d1ab6b2b38231e9250bf47de47ae1afaaa8c`. The installer is checksum-locked, refuses overwrites and requires the existing owner SSH alias `westcat`.
- **NOT VERIFIED:** graphical runtime/keyboard accessibility on a live display, MacBook installation, node policy OFF effect on the MacBook, actual daemon restarts under a realistic incident, native signing, notarization, and full system-wide recovery. No live policy/service changes were attempted.
- Release: internal unsigned source ZIP plus prebuilt archive on Big Mac only. Canonical DEX//REACH and DEX repositories untouched; no Git/CI/deployment actions claimed. No automatic reboot, monitor-driven restarts or Hermes/Ollama control added.

### Final truth-label correction and exact artifact supersession
An adversarial inspection found an overclaim in the first v0.2 graphical candidate: `DAEMONS RESPONDING` was derived only from `launchctl` process liveness, not responsiveness. Corrected to **DAEMONS RUNNING**, and stopped-state wording to **REQUIRED SERVICE STOPPED**. Source unit tests remained 16/16 PASS on Linux and Big Mac; the exact revised app was rebuilt on Big Mac and passed bundle verification. The previous first-candidate app ZIP (`3f15b208...`) remains retained but is **SUPERSEDED**; the installer must not use it.

Final Apple Silicon release artifact: `/Users/bigmac/DEX-Panic-v0.2.0-final-macos-arm64.app.zip`, **188,082 bytes**, SHA-256 `64e67f337097346f76842d3cd19cbb7c4c1605c7ef9c2b26de72471373f0d63f`. Final Mach-O arm64 app executable SHA-256 `fb0174daf988b916a56e73711effab75e8b943c8eebd6ca6396b236a60cb81d2`; bundle version remains `0.2.0`. Final macOS UI launch, runtime interaction, MacBook installation and signing/notarization **NOT VERIFIED**. No DEX runtime service or policy was changed; no canonical repository was committed or pushed.

## 2026-11-12 — v0.2.1 MacBook live status, bounded backups, publication packet

**Scope:** Standalone DEX//PANIC only. Canonical DEX//REACH runtime services, node policy, grants, credentials and private configuration were not changed. The public GitHub repository now contains `macos/DEX-Panic/` as a separate source directory; the v0.2.0 historical 'not yet committed' notes above are superseded for source publication, not rewritten.

- v0.2.1 non-template shield icon implementation: white for complete required-service liveness, red for degraded/unknown. Owner mode, coordinator admission and task completion remain separate. No live failure was induced to demonstrate the red visual state.
- Big Mac macOS `swift test --jobs 4`: 17 tests, zero failures in isolated source copy. Release arm64 binary passed compilation, plist/architecture verification. Installer has a checked, fixed `/bin/mkdir` path and 0.2.1 checksum pins; `zsh -n` is used as the static installer gate.
- **Verified MacBook:** `~/Applications/DEX Panic.app` v0.2.1 launched as real user `andrew`, executable SHA-256 `000ef0fc7554cde33a7a4a78381c2281d7ffbb8223ab902fca2d4beb48bc1050`, observed process PID `75729` at time of inspection. Four DEX services reported `launchctl state = running`, which proves only daemon liveness. No Dock/icon visual proof has been collected.
- **Backup:** original v0.2.0 app remains preserved at `~/Downloads/DEX-Panic-icon-fix-20261112/DEX Panic-v0.2.0-backup.app`; archive ZIP SHA-256 `577520219a4d7ca9d50eae3416c4651ee3783702dd9bab7f8319cba1cc57540b` was extracted into a new isolated MacBook directory and its plist, version and executable hash matched. Both 0.2.0 rollback and 0.2.1 archive copies are also present on Big Mac at `/Users/bigmac/DEX-Panic-Backups/2026-11-12/`, with archive integrity checks. **Restoring and launching v0.2.0 in place has not been performed**; there is no reason to disrupt the working v0.2.1 merely to simulate a rollback.
- **Evidence boundaries:** live owner policy-OFF, recovery after intentionally stopped critical services, actual GUI/VoiceOver color/keyboard behavior, full-task reconciliation, signing/notarization and any whole-machine backup remain NOT VERIFIED or OUT OF SCOPE. A GitHub source push does not itself back up MacBook runtime state or private node credentials.
- **Installer correction acceptance:** `--verify-only` validates fetch/extract/hash/version without touching the installed app. An existing download is reused only if hash matches. This is a source feature until a MacBook execution proves it.
- **Owner acceptance:** follow `TESTING.md`. Do not use real `STOP NEW REMOTE AI EXECUTION` or confirm a live service restart while a connected DEX client or unrelated tasks remain active.
- **Source delivery:** stage/publish only files inside `macos/DEX-Panic/` with an up-to-date GitHub `main` parent; verify remote head and CI independently after publication. No installation of DEX//REACH as part of this source change.

### Read-only installer test admission (not executed)

On the MacBook, attempting to stage the new `--verify-only` installer via the normal DEX//REACH node was refused **before execution**: `COORDINATOR_WAIT_TIMEOUT`, 3 substantive competitors/1 slot (3 uncoordinated heavy workloads). No copy/install/launch occurred from that attempt. This is a capacity boundary, not evidence the installer works or is broken. Static `zsh -n`, executable-path existence, archive/Plist hashes and isolated source tests are the supported proof; live `--verify-only` remains UNVERIFIED. Do not bypass the coordinator through an alternate remote transport.
