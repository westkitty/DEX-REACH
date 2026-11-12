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
