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
