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

C14-F2 protocol compatibility closure is already covered at current source scope by `docs/c14-compatibility/C14_F_MATRIX.md` and `tests/c14-mixed-version.test.ts`. Continue with the independent C14-H chaos coverage matrix, then C14-I/J, fresh C14-K validation, and C15 readiness preparation. Do not install, deploy, merge, or touch the owner runtime.
