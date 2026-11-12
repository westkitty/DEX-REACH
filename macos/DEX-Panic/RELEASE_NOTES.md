# DEX//PANIC v0.3.0 — Five-part reliability and evidence upgrade

- MacBook Air remains the **only** menu-bar UI. Big Mac provides read-only information over authenticated SSH; no Big Mac `.app` is installed.
- Added coordinator-classified workload groups distinct from the independent CPU/RSS shortlist, with explicit unavailable/incomplete classification states.
- Added read-only durable-task autopsy with node ID and truthful nonterminal/ambiguous/terminal interpretation; no task retry/resume/cancel paths.
- Added probe timing and last successful observation for each service; white/red shield behavior unchanged.
- Reduced duplicate menu-open refreshes within eight seconds and bounded CLI result read memory; measured MacBook CPU savings not claimed.
- Added a versioned, allowlisted `--panic` projection for Big Mac status and tasks. No PIDs, private paths, command-line arguments, credentials, agent prompts or task payloads appear in the projected data. Existing MacBook checkout is preserved.
- Owner-triggered, checksum-locked MacBook upgrade from known-good 0.2.3, with rollback. Big Mac source is installed only as isolated CLI files, not as a UI/app or service.
- Validation, hashes and publication state are recorded separately after QA. Unsigned and unnotarized internal build.

## Verified source and package evidence (before MacBook installation)

- Swift/macOS unit tests: **46/46 PASS**. Typed owner-evidence, host identity, unknown-state, read-only, clipboard and refresh-policy tests included.
- DEX root TypeScript: typecheck PASS; focused PANIC + capacity/coordinator/task-store suite **50/50 PASS**; TypeScript build PASS; **42/42 invariants PASS**. The full root integration suite was not completed in this release run.
- Live Big Mac read-only `work-status --panic` and `tasks --panic` commands: SUCCESS, schema 1, node `bigmac`, no raw paths, tokens, task payloads or arbitrary process arguments observed in output.
- Native internal Apple Silicon bundle: `com.stinkyweasel.dex-panic`, v0.3.0, build 6, LSUIElement true. Executable SHA-256 `6ded1cf197b2759982186acd032e7352585555e3ec6edaf4e905df8b219b7137`.
- MacBook-only application archive: `/Users/bigmac/DEX-Panic-v0.3.0-macos-arm64.app.zip`, SHA-256 `cfded298a85907b809074121d0c76b081f7b8d4cdcbef947f9dbe1c9f48ebebc`; ZIP integrity PASS.
- Signed/notarized: NO. MacBook installation, runtime CPU improvements and new GUI controls: NOT YET USER-VERIFIED.

---

# DEX//PANIC v0.2.3 — Two-machine competing-work inspector

- Adds **Inspect competing work** to the status-bar menu and Recovery Deck; separate MacBook Air and Big Mac tabs display process executable basename, CPU%, resident MiB, category and cautious explanation.
- Read-only, only on explicit click. No automatic termination, force-quit, restart, suspension, modification, elevated shell or scheduled remote scans are introduced.
- Remote target is fixed node ID bigmac / SSH alias westcat, with strict host-key check and remote username/hostname verification. No fallback when remote trust or response is unavailable. No listener exposed.
- Shows top CPU and RSS candidates and labels them **not exact matches** to the DEX coordinator's uncoordinated-heavy workload count. Never infer task identity from generic node/python names.
- Diagnostic copy includes a small, bounded, sanitized per-host process summary without PIDs, command args, private executable paths or unfiltered SSH results.
- Changes only this standalone app, not DEX//REACH source, service configuration, credentials or node-local policy.
- **Big Mac build verified:** macOS Swift tests 36/36 PASS; internal arm64 app 0.2.3 build 5 compiled and bundle checks PASS; executable SHA-256 `51502a7a20947d6d67d724710e71cab182a780259700eab56f6f2e58f01a31a5`; app archive SHA-256 `98ee33e9af48297831ac83c87da3cded1361d7a3e3ca25c908d598be8f62f4f5`. No signing/notarization.
- **MacBook not yet upgraded:** remote SSH inspection smoke was refused before execution by DEX coordinator (2 competing heavy jobs / 1 slot). Owner-triggered upgrade remains untested in live MacBook session; preserve v0.2.2 as rollback.

---

# DEX//PANIC v0.2.2 — Diagnostic guidance and copyable evidence

- Added a prominent **Copy diagnostic report** control in the Recovery Deck and menu bar. Only allowlisted, share-safe status fields and validated incident metadata are copied, with explicit snapshot timestamps and freshness/uncertainty limits. The owner must choose to paste it elsewhere; no network send occurs.
- Added plain-English diagnosis for timeout, incomplete snapshot, confirmed stopped service, missing launchd service, launchctl invocation error and all-running cases. Unknown states never enable forced restart.
- Added last-inspected typed memory, CPU, thermal, lease, queue and uncoordinated-work readings (only where the owner has explicitly requested capacity inspection). No private CLI output is stored.
- Replaced giant raw owner-policy/capacity alerts with concise explanations and safe next steps.
- The original 4-second service probe deadline is unchanged. A timeout means **inspection failed**, not that a daemon crashed. This release diagnoses uncertainty; it does not repair DEX runtime pressure or reconcile external task effects.
- Standalone AppKit/SwiftUI app, original service allowlist and node-local policy safety preserved. Bundle version 0.2.2 (build 4); internal unsigned and unnotarized.
- **Big Mac macOS verification:** 25/25 Swift tests passed, release arm64 build passed, bundle/plist verified; binary SHA-256 `4beac3014d243083d03517e1aabb5348feb961906029236163bfdb47b26b56cb`, app ZIP SHA-256 `43437ae614a238ab4d4be194847ac92d53eef60cfe4d9656e72ae498de143a23`. Installed-macOS GUI and clipboard still require independent proof.
- The MacBook installation, clipboard paste and visual UX tests must be verified after deploying the exact new binary. Do not claim GUI verification from compilation alone.

---

# DEX//PANIC v0.2.1 — High-contrast menu-bar indicator

**Scope:** Small safety/visibility update to the standalone macOS recovery application. v0.2.0 notes follow below as historical release evidence.

- Replaced the subtle template SF-symbol status-bar image with an explicitly colored **non-template** drawn shield. White means the required launchd daemons are observed running; red with exclamation means their observed liveness is degraded/unknown. It does not conflate liveness with policy, coordinator admission or task outcome.
- Added a regression test for healthy/degraded/unknown indicator mapping: **17/17 macOS Swift tests passed** on Big Mac (arm64 Swift 6.4).
- Incremented bundle version to `0.2.1` (build `3`), retaining the existing bundle identifier and menu bar behavior.
- Fixed the v0.2.0 prebuilt installer: `/usr/bin/mkdir` does not exist on macOS. v0.2.1 uses `/bin/mkdir`, points at the versioned Big Mac archive, and pins its executable and ZIP SHA-256 checksums. It remains **install-only and never overwrites an existing app**. It also supports a non-installing `--verify-only` mode and safe reuse of a previously verified archive.
- Compiled/verified release executable SHA-256: `000ef0fc7554cde33a7a4a78381c2281d7ffbb8223ab902fca2d4beb48bc1050`; prebuilt ZIP SHA-256: `1157ab28f4f6ce5792f1dbf652e2c6633d1d1a2edb874d415959234f87472cdd`.
- MacBook installed `0.2.1`; observed running executable and four DEX//REACH launchd services. The prior installed `0.2.0` was preserved as a rollback bundle, archived and extracted into an independent restoration-check folder. Both binary archives were separately preserved on Big Mac.
- **Unverified:** actual perceived menu-bar color/contrast, interaction with the Recovery Deck on a physical GUI, actual policy-OFF effect and restoration, and deliberate service-stop/recovery. Do not change DEX access/service state just to turn the shield red while work is running.
- Internal unsigned/unnotarized software. No change to installed DEX//REACH service code, credentials, ownership, roots, client authority or runtime policy.

---

# DEX//PANIC v0.2.0 — Local Recovery Deck

**Status:** Final code and native build validated on Big Mac. MacBook runtime not yet accepted. Internal unsigned build; no notarization.

## Why this release exists
A running gateway/node/coordinator is not proof that new work can be admitted, that an old task has finished, or that a lost response was safe to replay. DEX//PANIC must make those distinctions visible without depending on DEX connectivity for its own interface.

## Delivered
- A native SwiftUI Recovery Deck alongside the lean AppKit emergency menu. No web renderer or new listening port.
- Four evidence layers: service liveness, on-demand admission, owner access, unresolved task effects.
- Event history displayed as a metadata-only flight recorder. Reading is bounded to a short tail, and append stops at a 2 MiB cap without deleting prior events.
- Liveness classification refuses partial or duplicate required service snapshots.
- Fresh `launchctl print` guard before every targeted start/restart. A changed/unknown state refuses; a running service restart requires owner confirmation.
- Policy OFF reported only after an independent local CLI readback. Unknown result is never automatically replayed.
- Manual capacity inspection distinguishes `AVAILABLE` and `QUEUE`, but does not substitute admission for authority or task proof.
- Preserved `~/Applications` non-overwriting installer behavior; new checksum-locked prebuilt fetch installer for Apple Silicon over existing SSH alias `westcat`.

## Verified
- Linux: 16/16 `swift test` PASS.
- Big Mac Apple Silicon / Swift 6.4: 16/16 `swift test` PASS, debug build PASS, release bundle PASS, executable and plist verification PASS.
- Prebuilt ZIP (Big Mac): SHA-256 `64e67f337097346f76842d3cd19cbb7c4c1605c7ef9c2b26de72471373f0d63f`.
- Bundle executable SHA-256 `fb0174daf988b916a56e73711effab75e8b943c8eebd6ca6396b236a60cb81d2`.

## Deliberately not claimed
No MacBook installation, no GUI smoke or VoiceOver audit, no automatic self-healing, no durable task reconciliation, no service chaos test, no Hermes/Ollama controls, no code signing, no notarization and no remote repository commit or deployment.

## Rollback
The original Big Mac source and v0.1 compiled bundle were not overwritten. Installers refuse to overwrite an existing `~/Applications/DEX Panic.app`. No existing system or user state was migrated.
