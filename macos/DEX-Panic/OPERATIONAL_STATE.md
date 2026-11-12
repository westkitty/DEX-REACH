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

## 2026-11-12 — v0.2.2 diagnostic guidance / copyable report candidate

User observed all four service probes `UNKNOWN` with `Probe timed out`, while admission displayed `QUEUED AT CHECK`. Source confirmed `LaunchdSupervisor.probe` invokes `launchctl print` with 4-second timeout per service; observed unknown is a failed observation, not proof the daemon exited. The MacBook recently reported resource contention but causal attribution is unproven.

An isolated Big Mac source copy `/Users/bigmac/DEX-Panic-Diagnostics-0.2.2-20261112` was derived from clean published source commit `0b24e58c16ed12c5124a789dcea720fd37a86ec9` without mutating the canonical repository or installed MacBook app. v0.2.2 adds a bounded, share-safe text diagnostic with per-service reasons and timestamps, a plain-English explanation/next-step pane, copy feedback, and sanitized on-demand owner/capacity UI. Work resource metrics are only displayed if separately inspected. Unit tests verify interpretation and no accidental secret/path copying.

At initial implementation, the 25 macOS unit tests passed (8 additional tests), and SwiftUI AppKit code compiled. Final built archive, MacBook UI, clipboard, deployment and Git publication remain separate validation gates until observed. No live node policy or daemon was changed.

### v0.2.2 Big Mac build proof (not MacBook acceptance)

- macOS Swift 6.4: `swift test --jobs 4` 25/25 passed; `scripts/build-app.sh` compiled the standalone AppKit/SwiftUI arm64 app; `scripts/verify-app.sh` passed bundle identity/version and executable checks.
- Current built app: `/Users/bigmac/DEX-Panic-Diagnostics-0.2.2-20261112/dist/DEX Panic.app`, CFBundleShortVersionString `0.2.2`, build `4`; executable SHA-256 `1c113a0ded8c8b9d3cb74deeab529585c0ddf15c2efc71186118e699837580df`.
- Prebuilt archive on Big Mac: `/Users/bigmac/DEX-Panic-v0.2.2-macos-arm64.app.zip`, SHA-256 `6d642fafc3dd6e0aafbeef5f4c92772faafa97830d3b82d3327b91d3de008286`; archive integrity verified. Installer updated with both hashes and version 0.2.2.
- Not verified: exact MacBook installation and visual clipboard interaction, real-world false-timeout behavior, network, code signing/notarization, or actual remote task reconciliation. The v0.2.1 installation and backups are preserved. No commit/push or node policy change in this bounded feature pass.

### Final v0.2.2 binary supersession

A final security regression established that interpretation must use canonical registry service titles rather than titles carried by potentially untrusted probe objects. The prior candidate executable (`1c113a0...`) and ZIP (`6d642faf...`) were **SUPERSEDED** and were NOT installed. The final revised source ran **26/26 macOS tests** with zero failures; `scripts/build-app.sh` and `scripts/verify-app.sh` completed on Big Mac. Final v0.2.2 executable SHA-256 `4beac3014d243083d03517e1aabb5348feb961906029236163bfdb47b26b56cb` and final archive `/Users/bigmac/DEX-Panic-v0.2.2-final-macos-arm64.app.zip` SHA-256 `43437ae614a238ab4d4be194847ac92d53eef60cfe4d9656e72ae498de143a23`. Upgrade and first-install scripts are checksum-locked to this exact final archive; upgrading is explicit and refuses unexpected v0.2.1 binaries. No installed MacBook app was replaced by this build, and no Git commit/push or DEX policy/service restart has been executed as part of the candidate production.

## 2026-11-12 — v0.2.3 process inspector candidate / safety gate

Scope: **DEX//PANIC standalone Mac App only**, isolated Big Mac source at `/Users/bigmac/DEX-Panic-Competing-Work-0.2.3-20261112` derived exactly from previous v0.2.2 source, without overwriting any prior source/installed app. Build 5.

- New manually invoked two-host process inspector: MacBook native read-only ps CPU/RSS samples, Big Mac single bounded SSH read-only sampling through owner-authenticated `westcat` with fixed explicit target node ID `bigmac`, strict known-host checking, fixed expected remote hostname/account and no remote fallback. Only executable basename, CPU%, RSS MiB and cautious category explanations retained. No kill/restart/stop/disable/force-quit/automatic termination capability added. No background polling of Big Mac.
- UI has MacBook and Big Mac separate machine tabs, timestamp/status including UNAVAILABLE, process explanation rows, and report export with sanitized process shortlist but no args, PIDs or paths. Coordinator heavy-work count remains a separate observation and is not attributed to individual rows.
- **Verified Big Mac:** `swift test --jobs 4`: 36/36 PASS, including remote identity, fail closed, read-only command restrictions, parser and clipboard privacy; native macOS arm64 build and bundle verify PASS, bundle `0.2.3` build `5`. Executable SHA-256 `51502a7a20947d6d67d724710e71cab182a780259700eab56f6f2e58f01a31a5`; app ZIP SHA-256 `98ee33e9af48297831ac83c87da3cded1361d7a3e3ca25c908d598be8f62f4f5`.
- **Unverified MacBook:** exact installed/GUI process-inspection flow, live remote SSH collector and per-host acceptance. DEX coordinator refused a read-only remote smoke during 2 uncoordinated heavy jobs / 1 substantive slot. Refusal respected; no route bypass or DEX service/policy mutation. v0.2.2 remains installed until explicit safe upgrade; rollback script is checksum-locked but MacBook execution still unverified.
- Source has not been committed or pushed in this change. Google Drive archive not yet verified. Signed/notarized release not performed.

## 2026-11-12 — v0.3.0 five-lane release candidate, Big Mac source only

A clean isolated source checkout rooted at `/Users/bigmac/DEX-Panic-0.3.0-Release-20261112` was created from canonical `westkitty/DEX-REACH` main `0b24e58c16ed12c5124a789dcea720fd37a86ec9`. The prior v0.2.3 source was restored from its checksum-verified archive and only authorized DEX//PANIC and read-only owner CLI paths were changed. An unrelated dirty Big Mac checkout and the live MacBook DEX runtime were not modified.

C01 release chain: app v0.3.0 build 6 (`6ded1cf197b2759982186acd032e7352585555e3ec6edaf4e905df8b219b7137` SHA-256) compiled on Big Mac. App archive at `/Users/bigmac/DEX-Panic-v0.3.0-macos-arm64.app.zip` SHA-256 `cfded298a85907b809074121d0c76b081f7b8d4cdcbef947f9dbe1c9f48ebebc`, integrity PASS. MacBook upgrade script requires exact v0.2.3 source binary and preserves rollback. Publication and actual installed runtime must be verified separately; initial coding state is source-tested, not MacBook-installed.

C02 read-only coordinator classification: `src/shared/panic-projection.ts` and owner-only `work-status --panic` expose a versioned, bounded, allowlisted grouping projection with counts and thresholds. `OwnerEvidence.swift` accepts the projection for authenticated Big Mac through `westcat`, validates explicit node and groups, and accepts MacBook's existing local CLI JSON only after strict typed inspection. No process arguments, PIDs, lease details, project paths or tokens enter the share-safe projection.

C03 shield causality: recorded per-daemon launchctl probe time in ms, last positive running timestamp and total probe-cycle duration. Unknown remains unknown; white/red conservative icon retained, no auto-restart.

C04 reduced overhead: menu opened within eight seconds of the last successful cycle does not duplicate probes; explicit refresh works. CLI output readback bounded to at most 64 KB instead of loading whole temporary files. Release testing provides deterministic policy tests and observability, but there is NO matched installed-MacBook CPU/RSS benchmark proving a numerical gain.

C05 read-only durable-task autopsy: `tasks --panic` returns at most eight typed, node-matched task rows (ID, operation, state, updated time and result-reference flag). UI interprets AMBIGUOUS, INPUT_REQUIRED and terminal states conservatively. No task retry/resume/cancel/reconcile controls.

**Big Mac is information-only, no menu-bar app installed there.** Host identity checked before remote CLI/probe data accepted. A MacBook-only installer explicitly refuses Big Mac installation. Big Mac's live installed DEX node, gateway, coordinator, owner policy, credentials, permissions and services are unchanged.

Validation: macOS Swift 46/46 PASS; root TypeScript typecheck PASS; focused suite 50/50 PASS; root build PASS; 42/42 invariants PASS; Big Mac direct read-only projection smoke PASS. Full suite, MacBook runtime installation, end-to-end SSH GUI and matched performance remain separate gates. Source commit/push expected only after exact Git diff and archive receipts pass; do not infer completion from this entry.
