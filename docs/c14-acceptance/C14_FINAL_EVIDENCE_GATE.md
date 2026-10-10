# C14 final evidence gate

## Frozen candidate

Candidate source is `c14-chaos-recovery` at
`7161f95536f7ca787f1772f5afdd66c3e274f351`, pushed with exact remote parity.
The worktree is clean. This frozen candidate contains documentation and
traceability additions only after the previously validated source; hosted CI
also executed the exact head.

## Adversarial nine-category assessment

| Requirement | Source/test evidence | Hosted CI | Installed/runtime | Ecosystem | Verdict and release implication |
| --- | --- | --- | --- | --- | --- |
| Chaos across gateway/node/coordinator/worker/WebSocket and interruption phases | C14-H matrix; routing, disconnect, worker, task and recovery fixtures | PASS on loopback runtime-proof | Physical service interruption blocked | Not applicable to REACH-only fixtures | PARTIAL: dedicated node/worker durable-process and host-service interruption remain open |
| Mutation ambiguity/no blind replay | C14-A/B, boot recovery repair, result binding, ambiguity tests | PASS | Installed interruption unverified | External product effects not exercised | PASS at source scope; no release claim for physical boundary |
| Performance and matched measurement | C14-D, corrected C14-E, C14-J | PASS for repository gates | Installed idle profiling not measured | Product dashboard integration unverified | PASS isolated source scope; installed observability remains a limitation |
| Long-session lifecycle | 661.1-second corrected isolated confirmation, 3,611 cycles, zero failures, cleanup | Full suite PASS | No installed long-session run | Search/provenance product growth unverified | PASS source-only; historical pre-repair partial retained |
| Security | 42 invariants and security/access/budget/replay/revocation tests | PASS + CodeQL PASS | Installed policy proof is historical, not this candidate | Cross-product trust runtime unverified | PASS current REACH source scope |
| Privacy | Secret, trace, receipt, share projection and control-room tests | PASS | Installed UI acceptance not rerun | PAIR/DROPZONE/WITNESS integrated proof absent | PASS REACH source scope; ecosystem partial |
| Mixed-version migration | C14-F2 current Protocol v1 capability matrix and explicit legacy refusal | PASS | No installed mixed-version migration | DEX registry expects versioned contract | PARTIAL: genuine ADR-0003 v2 dual-stack not implemented |
| Cold-start/reconstructability | Fresh detached install, 160-artifact clean build, exact master-plan recovery | Reproducible-build PASS | Installed/source distinction preserved | DEX source separately inspected | PASS reconstruction; independent evaluator unverified |
| Failure prevention and closure | Demonstrated defects have regression fixtures; focused and full suite green | Validate PASS | No physical failure injection | DEX negative fixtures exist, no REACH consumer | PASS for recorded source defects; future defects still require fixtures |

## Separate verdicts

- **C14 SOURCE ACCEPTANCE: PASS within tested repository scope.**
- **C14 PROGRAM ACCEPTANCE: PARTIAL / NOT COMPLETE.**

The unresolved rows are not silently waived. They require installed/physical
authority, a protocol migration decision or implementation, DEX ecosystem
integration evidence, independent evaluation, installed observability, and
human/connector acceptance. C15 therefore remains blocked.

## Final checks

- Full suite: 385/385 PASS, 0 failed, 0 skipped.
- Typecheck: PASS.
- Invariants: 42/42 PASS.
- Build: PASS.
- Audit: PASS at high-severity threshold; six moderate advisories remain.
- Backend probe: PASS, 26 tools.
- Diff check: PASS.
- Hosted validation: PASS, run `38024604247`, exact head SHA.
- CodeQL: PASS, run `38024604152`, exact head SHA.
