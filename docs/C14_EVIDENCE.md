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

## C14-C — security and privacy regression hardening

| Field | Evidence |
| --- | --- |
| Requirement scope | Durable result identity, recovery integrity, duplicate binding, privacy-safe summaries, and preserved existing authorization boundaries |
| Regression file | `tests/c14-security-privacy.test.ts` |
| Reproduced defect | Boot recovery and task result retrieval checked blob integrity but did not require the result metadata task ID and hash to match the persisted task. A valid result belonging to another task could have satisfied recovery after task-state corruption. |
| Repair | `ResultStore.readValueForTask` requires task ID and expected hash; boot recovery, task result control, and duplicate-result reattachment use it. Completed tasks missing result binding are refused as corrupt rather than recovered. |
| Adversarial coverage | Wrong task reference, wrong result hash, corrupt completed binding, ambiguous recovery preservation, synthetic credential redaction, plus existing node-auth, access-policy, task-control, coordinator ownership, result-store, and security regressions |
| Focused result | 66/66 PASS; typecheck, build, 42 invariants, and `git diff --check` PASS |
| Status | PASS at focused source/regression scope; no live service, connector, or physical chaos proof claimed |

The full-suite aggregate remains **UNKNOWN**. The bounded prior diagnosis remains valid: the existing nonce-cache test takes about 58 seconds alone and passes; no C14 interaction was observed. Hosted CI is unavailable for the standalone branch unless a workflow is triggered separately.

## C14-D — performance baseline and matched repeat

| Field | Evidence |
| --- | --- |
| Requirement scope | Task acknowledgement, status reads, event append, task-store growth, result store, coordinator admission/queue/release, bounded event pagination, resource observations, and dashboard/idle-service measurement boundaries |
| Harness | `scripts/c14-performance.ts`, exposed as `npm run benchmark:c14`; every fixture uses a temporary `DEX_REACH_STATE_DIR` and is removed after measurement |
| Baseline | Source `fada83b85ce60aa64f81bc5314148d0c683737d0`; 15 measured iterations after 3 warmups; raw artifact `docs/c14-performance/c14-d-baseline-fada83b.json` |
| Matched final | Source `f0bc40b43059e7bdd00de344d0f89f1fe27f023d`; same harness, fixture sizes, machine, and sampling method; raw artifact `docs/c14-performance/c14-d-final-f0bc40b.json` |
| Result | C14-D baseline PASS and matched final PASS as repeatability evidence. No production optimization was justified; no production behavior changed. |
| Key observation | Coordinator acquire/release was the highest measured category, with a final median of 34.07 ms and p95 of 36.35 ms. The bounded task-store and result-store measurements showed no supported asymptotic defect at the tested sizes. |
| Unmeasured | Dashboard delta refresh and installed-service idle CPU/memory remain NOT MEASURED. Long-session stress is deferred. |

See the [C14-D report](c14-performance/c14-d-report.md) and [raw baseline](c14-performance/c14-d-baseline-fada83b.json). This is source-only isolated evidence, not installed-runtime, connector, physical-device, or human-acceptance proof.

## C14-E — bounded long-session stress and resource lifecycle

| Field | Evidence |
| --- | --- |
| Requirement scope | Bounded long-session stress across normal completion, retrieval, coordinator lifecycle/queue, controlled failure, ambiguity/recovery/no replay, event/result persistence, resource sampling, and cleanup |
| Harness | [scripts/c14-stress.ts](../scripts/c14-stress.ts), exposed as `npm run stress:c14`; corrected runs use an ephemeral `DEX_REACH_STATE_DIR` and remove that exact directory |
| Sustained result | [Raw report](c14-performance/c14-e-stress-results.json): 607.7 seconds, 2,134 cycles, concurrency 2, zero failed cycles; 853 normal, 214 failed, 119 ambiguity/recovery cycles |
| Resource result | Early/middle/late RSS 81.9/199.8/211.6 MiB; late task/result/event stores 1.84 MiB/406 KiB/653 KiB; cleanup found zero leases, zero tickets, no socket, and `temporaryStateRemoved=true` |
| Repair | Repeated unchanged recovery-status persistence was demonstrated to drift to 2.27 s median and 6.26 s p95 late in the pre-repair sustained run. Conditional persistence was added in `src/node/boot-recovery.ts`; the regression asserts unchanged `updatedAtUtc` and event count |
| Post-repair confirmation | [Matched smoke](c14-performance/c14-e-smoke-final.json): 75.4 seconds, 721 cycles, zero failures; recovery median 107.66/119.46/121.33 ms early/middle/late |
| Status | **PARTIAL**. The sustained run predates the repair and has no exact committed source SHA. Initial harness revisions omitted the temporary-state environment assignment and appended synthetic coordinator history to the owner namespace. Active owner leases/tickets were cleaned and re-read as zero, but historical entries remain preserved. No installed-runtime, physical-chaos, connector, Big Mac, public-exposure, or human-acceptance proof is claimed. |

See the [C14-E report](c14-performance/c14-e-stress-report.md). C14-E is source-level bounded evidence only; C14 overall remains incomplete.

### C14-E corrected sustained confirmation

| Field | Evidence |
| --- | --- |
| Exact source | `5b569d8bc21fdddb132d82385ed64eefd5dba2f1` on `c14-chaos-recovery`; runtime-bound by `git rev-parse` before execution |
| Sustained result | [New raw artifact](c14-performance/c14-e-stress-confirmation.json): 661.1 seconds, 3,611 cycles, concurrency 2, zero failed cycles; 1,445 normal, 361 failed, 215 ambiguous tasks |
| Coverage | Normal completion, indexed retrieval/listing, coordinator acquire/release, queue admission/cancellation, controlled failure, AMBIGUOUS_EFFECT preservation, duplicate refusal, result binding, event append/pagination, periodic recovery, and cleanup |
| Recovery | Early/middle/late median and p95: 83.3/116.6 ms, 177.0/326.3 ms, and 204.1/304.2 ms. The pre-repair multi-second drift was not reproduced under this bounded workload. |
| Resources | Early/middle/late RSS: 75.5/218.1/261.6 MiB; late task/result/event stores: 3.14 MiB/687.3 KiB/543.3 KiB. Growth tracks the intentional fixture; no resource-pressure stop fired. |
| Cleanup | Zero leases/tickets; 215 expected ambiguous tasks preserved; 1,806 terminal tasks archived; 1,445 results expired; socket absent; temporary fixture removed; no duplicate synthetic effects or incorrect bindings. |
| Isolation | Runtime asserted all persistent workload paths under `/var/folders/lm/f_zcrpb94bvg69m2y35klb8r0000gn/T/dex-c14-stress-rPhXJp`; owner root was excluded. Owner history digest changed from 17,783 to 17,952 bytes; tail showed installed cache/classifier events, so workload attribution is `UNKNOWN`, not a clean no-change claim. Current owner state is zero leases, zero tickets, `degraded=false`. |
| Validation | Path regression 4/4, focused C14-A/B/C 67/67, typecheck, 42 invariants, build, and `git diff --check` PASS. Full suite and hosted CI UNKNOWN. |
| Status | **PASS at corrected isolated source-only sustained-confirmation scope.** Historical pre-repair C14-E remains PARTIAL and unchanged. No installed-runtime, physical-chaos, connector, Big Mac, public-exposure, or human-acceptance proof is claimed. |

See the [corrected confirmation report](c14-performance/c14-e-stress-confirmation-report.md). C14 overall remains incomplete.

## C14-F — mixed-version compatibility and migration safety

| Field | Evidence |
| --- | --- |
| Contract | ADR-0003 semantic `1.0`/`2.0` negotiation is implemented additively. Legacy `protocolVersion: 1` remains unchanged for transport-auth and historical hello compatibility. |
| Matrix fixtures | [C14-F matrix test](../tests/c14-mixed-version.test.ts) covers negotiation/refusal semantics; [loopback fixture](../tests/c14-protocol-v2-loopback.test.ts) uses isolated IPv4 WebSocket connections, synthetic bearer credentials, and temporary state. |
| v2 path | Current v2 gateway and node negotiate `2.0`, intersect `durable_tasks`, `task_event_stream`, `task_reconciliation`, and `two_phase_plan`, and admit durable execution. The node emits bounded content-free accepted/completed/failed task frames. |
| Legacy path | Historical v1 hello omission negotiates `1.0`; v2 nodes remain synchronous-compatible through a v1 gateway. Durable requests are refused explicitly at the current gateway boundary, and the node independently refuses durable envelopes when no v2 acknowledgement was received. |
| Matrix status | A-F source fixtures: **IMPLEMENTED_AND_TESTED**. No silent downgrade, phantom handle, node fallback, identity widening, or policy bypass is introduced. |
| Validation | Full repository run 387/387 PASS; focused loopback/matrix tests 7/7 PASS; typecheck, 42 invariants, build, audit threshold, and `git diff --check` PASS. Hosted CI requires a fresh exact-head result. |
| Status | **PASS at source and isolated loopback-fixture scope; PARTIAL for installed mixed-version migration and external connector/runtime acceptance.** No installed runtime, public connector refresh, live migration, credential/policy change, or production restart was performed. |

See the [C14-F matrix report](c14-compatibility/C14_F_MATRIX.md). C13 remains NOT PASS, E7 remains BLOCKED — HOST CAPABILITY, and C14 overall remains incomplete.
