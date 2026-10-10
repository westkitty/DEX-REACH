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

The repository-wide `npm test` invocation was previously observed beyond the bounded window in `phase-6-10-corrections.test.ts`. A bounded isolation run identified the exact cause: `a full nonce cache refuses new proofs instead of forgetting replayable ones` takes about 58 seconds alone and passes; the C14-A/B tests pass before it. No C14 interaction was observed. The full-suite aggregate remains **UNKNOWN**, not PASS, because no unbounded rerun was used to convert the earlier incomplete observation into a repository-wide result.

## C14-B — mutation ambiguity and safe recovery

| Field | Evidence |
| --- | --- |
| Requirement scope | Mutation uncertainty after a lost response; no blind replay |
| Harness | `tests/c14-mutation-ambiguity.test.ts`; ephemeral state, isolated coordinator daemon, IPv4 loopback transport, deterministic external-effect oracle file |
| Scenario | One `PROCESS_UNKNOWN_EFFECT` mutation reaches `RUNNING`; the fake external system records one effect; transport terminates before any DEX result or receipt; coordinator lease is released; boot recovery reopens the original task |
| Recovery | First reopen classifies the task `AMBIGUOUS` and persists `failureClass=AMBIGUOUS_EFFECT`; second reopen preserves `AMBIGUOUS` and returns `INPUT_REQUIRED`; no result or receipt is invented |
| Replay refusal | Same identity returns `REFUSE_AMBIGUOUS`; changed actor, node, or payload returns `COLLISION`; execution counter remains exactly 1 |
| Identity and cleanup | Original task ID, actor, node, idempotency key, and missing result reference are preserved; unrelated lease survives; task lease and ticket are absent |
| Focused result | C14-A/B plus adjacent durability, task-store, result-store, boot-recovery, and coordinator tests: 29/29 PASS; typecheck, build, 42 invariants, and `git diff --check` PASS |
| Status | PASS at focused source/regression scope; not physical chaos proof and not whole-C14 PASS |

### Source changes

- `src/shared/durable-execution.ts` now owns the duplicate-task decision so actor, node, operation, payload, policy, terminal result, ambiguity, and in-flight states cannot be bypassed by a filtered lookup.
- `src/node/main.ts` uses that decision before authorization/execution and refuses ambiguous or binding-collision requests.
- `src/node/boot-recovery.ts` persists `AMBIGUOUS_EFFECT` when recovery lacks authoritative result evidence.

The installed C13 runtime, live services, connector, Big Mac, PR #15, `main`, credentials, and owner task state were not changed.
