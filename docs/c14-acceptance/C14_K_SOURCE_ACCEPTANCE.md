# C14-K source acceptance matrix

## Scope and verdict

This is the final source-only acceptance record for the autonomous C14 campaign on
`c14-chaos-recovery`. It does not certify the installed runtime, physical host,
public connector, DEX ecosystem conformance, hosted CI, or human acceptance.

**Source hardening: PASS within the measured repository scope.** The repository
is type-safe, buildable, invariant-clean, reproducible from a fresh dependency
install, and the comprehensive suite passed 385/385 tests.

**C14 program acceptance: NOT COMPLETE (PARTIAL).** The master-plan source was
not available for independent nine-category reconciliation, several physical or
ecosystem gates remain unverified, and ADR-0003 Protocol v2 migration is not
implemented by the current Protocol v1 source.

## Nine-category matrix

| Category | Requirement and evidence | State | Remaining boundary / release implication |
| --- | --- | --- | --- |
| 1. Response-loss and identity recovery | C14-A/B recovery, result binding, durable-task tests; corrected C14-E confirmation; full suite 385/385 | PASS at source scope | Installed response-loss and physical interruption proof remains unverified |
| 2. Mutation ambiguity and no-replay | `boot-recovery.ts` repair, ambiguity persistence tests, C14-B recovery evidence, no blind replay checks | PASS at source scope | Historical harness/owner-history ambiguity is preserved; no installed chaos replay was authorized |
| 3. Result binding and security integrity | Exact node/actor/task/result binding, signed receipts, replay, auth, path and budget regressions; C14-I matrix | PASS at current REACH source scope | DEX ecosystem trust cross-product remains unverified |
| 4. Coordinator, transport, and chaos recovery | C14-H matrix; routing, coordinator disconnect, task-control, result-store, transport and lease fixtures | PASS for supported source fixtures; PARTIAL for dedicated process interruption | Physical installed interruption is blocked without owner maintenance authority |
| 5. Performance baseline and matched measurement | C14-D baseline/matched repeat and C14-J reconciliation with uncertainty retained | PASS for source benchmark evidence | Installed idle CPU/memory and dashboard delta refresh were not measured |
| 6. Bounded long-session and resource lifecycle | Corrected C14-E isolated sustained confirmation: 661.1 s, 3,611 cycles, concurrency 2, zero failures, cleanup verified | PASS at source-only scope | Historical pre-repair C14-E remains PARTIAL; no installed runtime claim |
| 7. Security, privacy, and trust boundaries | C14-I matrix plus access, secrets, receipts, traces, policy, coordinator and control-room regressions | PASS at current REACH source scope | PAIR PRIVATE/SEALED, DROPZONE, WITNESS runtime conformance is UNVERIFIED |
| 8. Mixed-version compatibility and migration | C14-F2 5/5 matrix tests; current Protocol v1 capability contract and explicit legacy refusal/fallback | PASS for current source contract; PARTIAL for ADR v1/v2 migration | Genuine ADR-defined Protocol v2 wire interoperability is unsupported and needs a release decision |
| 9. Cold-start, reconstructability, and observability | C14-G fresh `npm ci`, typecheck, build, 42 invariants, 10/10 focused tests, 160-artifact clean-build; C14-J gap record | PASS for source reconstruction; PARTIAL for independent evaluation | Master-plan DOCX missing; second blind evaluator, installed revision display, and some observability proof unavailable |

## Final validation record

- `npm test`: **385/385 PASS**, 0 failed, 0 skipped, 145.4 seconds.
- `npm run typecheck`: PASS.
- `npm run invariants -- --check`: PASS, 42 release-blocking invariants.
- `npm run build`: PASS.
- `npm audit --omit=dev --audit-level=high`: exit 0; six moderate advisories remain. No `audit fix` was run.
- `npm run probe:backend`: PASS, 26 local compatibility tools enumerated.
- `git diff --check`: PASS.
- Fresh detached C14-G reconstruction: `npm ci`, clean-build byte comparison for 160 artifacts, and focused 10/10 PASS.

## Protected state and next gate

No installer, service restart, deployment, merge, connector refresh, credential
operation, policy change, Big Mac action, network service, or physical chaos was
performed. The installed runtime, owner coordinator state, credentials, main
branch, and PR #15 were preserved. The branch remains source-only evidence.

C15 remains **BLOCKED** until C14 program acceptance is separately closed, the
Protocol v1/v2 release decision is made, and owner-authorized installed/physical,
connector, ecosystem, and human-acceptance gates are executed.
