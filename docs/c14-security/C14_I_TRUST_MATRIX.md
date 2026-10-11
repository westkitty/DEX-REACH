# C14-I security, privacy, and trust-boundary reconciliation

## Verdict

**PASS at current REACH source-regression scope; UNVERIFIED for separate DEX ecosystem runtime conformance.**

No new security defect was demonstrated in the targeted audit. Existing regressions cover the current authority and privacy boundaries; this matrix records the evidence and remaining limits.

| Boundary | Current evidence | State |
| --- | --- | --- |
| Exact node, unknown/offline/revoked target, no fallback | `tests/routing.test.ts`, `c14-mixed-version.test.ts` | PASS |
| Protocol/auth identity and replay | `tests/node-transport-auth.test.ts` | PASS |
| OFF/READ-ONLY/ON, client grants, budgets | `tests/access.test.ts`, `tests/budget.test.ts` | PASS |
| Corrupt policy and fail-closed authorization | `tests/access.test.ts`, `tests/security.test.ts` | PASS |
| Task ownership, actor/node/payload collisions, idempotency | `tests/durable-execution.test.ts`, `task-control.test.ts` | PASS |
| Result/task/hash binding and corrupt metadata | `tests/c14-security-privacy.test.ts`, `result-store.test.ts` | PASS |
| Ambiguity, forged recovery, no replay | C14-B, C14-C, `task-recovery.test.ts` | PASS |
| Lease ownership and forged release | coordinator ownership/disconnect tests | PASS |
| Paths, traversal, symlink escape, compatibility guard | `tests/security.test.ts`, `access.test.ts` | PASS |
| Credentials, receipts, plans, trace redaction | `tests/secrets.test.ts`, `receipts-plans.test.ts`, trace tests | PASS |
| Share-safe task/events/coordinator/control-room projections | `tests/c14-security-privacy.test.ts`, `tests/control-room.test.ts`, coordinator tests | PASS at source scope |
| PAIR PRIVATE/SEALED, DROPZONE, WITNESS cross-product conformance | No authoritative runtime fixture in this repository | UNVERIFIED |

Synthetic secrets remain test-only and are asserted absent from share-safe or persisted public projections where applicable. No public surface was expanded and no separate DEX repository was modified.

The cross-product rows require the authoritative DEX ecosystem contracts and runtime fixtures. They are not converted into PASS by source inspection.
