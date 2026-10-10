# C14 autonomous campaign ledger

This ledger records source-level campaign state. It does not certify installed runtime, public connector, physical host, or human acceptance.

## Baseline

- Repository: `westkitty/DEX-REACH`
- Worktree: `/Users/andrew/dex-reach-c13-worker-repair`
- Branch: `c14-chaos-recovery`
- Campaign starting HEAD: `bae8492d2e960f15b2684e0f3645b2206877b8b1`
- Protected state: installed C13 runtime unchanged; C13 NOT PASS; E7 BLOCKED — HOST CAPABILITY; C15 not started

## C14-G — cold-start recovery

- Status: PASS for isolated source reconstruction; PARTIAL for independent evaluation.
- Evidence: `docs/c14-recovery/C14_G_COLD_START_REPORT.md`, `docs/c14-recovery/C14_G_RUNBOOK.md`
- Fresh worktree: detached `bae8492`; `npm ci` PASS; typecheck PASS; build PASS; 42 invariants PASS; focused 10/10 PASS; clean-build 160 artifacts byte-for-byte PASS.
- Limitation: second blind evaluator unavailable; original master-plan DOCX remains missing.
- Documentation repair: historical `docs/C14_PREPARATION.md` now has an explicit current-state note.

## Next executable packet

## C14-F2 — protocol compatibility closure

- Status: PASS at current-source compatibility scope; PARTIAL for genuine ADR v1/v2 interoperability.
- Evidence: `docs/c14-compatibility/C14_F_MATRIX.md`, `tests/c14-mixed-version.test.ts`, 5/5 matrix tests and combined 46/46 compatibility-adjacent tests.
- No Protocol v2 constant or production path was invented. Genuine v2 combinations remain explicitly unsupported.

## C14-H — isolated chaos matrix

- Status: PASS at supported source-fixture scope; PARTIAL for dedicated node/worker process interruption; BLOCKED for physical installed interruption.
- Evidence: `docs/c14-chaos/C14_H_MATRIX.md` plus existing C14-A/B, coordinator disconnect, result-store, task-control, routing, and recovery fixtures.

## C14-I — security/privacy/trust boundaries

- Status: PASS at current REACH source-regression scope; ecosystem runtime conformance UNVERIFIED.
- Evidence: `docs/c14-security/C14_I_TRUST_MATRIX.md` and existing access, budget, security, secrets, receipts, trace, coordinator, and control-room tests.

## C14-J — observability/performance gaps

- Status: PASS for source-level gap reconciliation; dashboard delta refresh and installed-service idle profiling remain NOT MEASURED.
- Evidence: `docs/c14-performance/C14_J_GAP_RECONCILIATION.md`, C14-D report, and corrected C14-E confirmation.

## C15 preparation

- Status: BLOCKED because C14 program acceptance is incomplete and release/install/deploy authority is not granted.
- Evidence: `docs/C15_READINESS_PREPARATION.md`.

## Next executable packet

C14-K fresh source validation and acceptance matrix. Do not install, deploy, merge, or touch the owner runtime.
