# C14 evidence ledger

## Phase entry exception — 2026-10-09

Owner-approved exception: C14 source development is permitted while C13 remains **NOT PASS** and E7 remains **BLOCKED — HOST CAPABILITY**. No E7 result is waived or represented as passed. This exception permits isolated source development, regression tests, bounded non-destructive simulations, documentation, and scoped C14 branch publication. It does not permit changing C13 to PASS, merging PR #15, modifying `main`, installing or deploying a runtime, physical chaos, credential or connector administration, or C15 execution.

Historical C13 preparation remains preserved in `docs/C14_PREPARATION.md`; its original entry gate is not rewritten.

## C14-A — durable recovery after lost response

| Field | Evidence |
| --- | --- |
| Requirement scope | REQ-C14-001 / REQ-C14-002 / REQ-C14-009, first isolated response-loss packet |
| Target | `c14-chaos-recovery`, rooted at C13 repair source `391d0b0024b0db8e8da473e5a683a92d190bdb13` |
| Harness | `tests/c14-chaos-recovery.test.ts`; ephemeral state directory and IPv4 loopback transport; no installed service or owner task store |
| Scenario | One task and one coordinator lease; operation executes once; result and signed receipt persist; requester closes before response; task remains `RUNNING`; transport closes; stores reopen; boot reconciliation finishes from the original result reference |
| Assertions | Stable task ID, node, actor, idempotency key, result reference/hash; exactly one execution; verified receipt chain; terminal `COMPLETED`; no task lease/ticket leak; unrelated lease survives; no fallback node or authority widening |
| Status | PASS at focused source/regression scope: C14-A 1/1, adjacent durability/recovery/coordinator set 28/28, typecheck, build, 42 invariants, and `git diff --check` passed |

No physical service restart, connector interruption, installed-runtime change, Big Mac access, or release publication is claimed by this ledger.

## Verification boundary

The repository-wide `npm test` invocation was started but did not reach a trustworthy aggregate result within the bounded observation window; it remained active in the existing `phase-6-10-corrections` test process and was stopped. Full-suite status is therefore **UNKNOWN**, not PASS. This does not invalidate the focused 28/28 result above, but it remains uncovered scope for this source packet.
