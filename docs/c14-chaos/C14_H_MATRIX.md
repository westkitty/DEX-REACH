# C14-H isolated chaos matrix

## Scope verdict

**PASS at supported source-fixture scope; PARTIAL for physical and installed-service interruption.**

The repository already contains isolated process and temporary-state fixtures for the highest-risk durable boundaries. This matrix reconciles them without rerunning the completed C14-E stress workload or interrupting installed services.

| Boundary | Evidence | State | Limitation |
| --- | --- | --- | --- |
| Gateway unavailable before submission | `tests/routing.test.ts` unknown/offline/revoked target refusals | PASS | Source registry seam, not installed gateway outage |
| Response lost after result persistence | `tests/c14-chaos-recovery.test.ts` loopback transport | PASS | Test-owned transport and stores |
| External effect before result/receipt | `tests/c14-mutation-ambiguity.test.ts` independent effect oracle | PASS | Synthetic external oracle, not a live external system |
| Coordinator disconnect, delayed reply, EPIPE | `tests/coordinator-disconnect.test.ts` child coordinator process | PASS | Test-owned child process |
| Duplicate request and no replay | `tests/durable-execution.test.ts`, `c14-mutation-ambiguity.test.ts` | PASS | Source-level identity and oracle assertions |
| Fresh recovery of durable state | `tests/task-recovery.test.ts`, C14-A/B fixtures | PASS | Reopened stores; installed restart not exercised |
| Stale capability after reconnect | `tests/c14-mixed-version.test.ts` | PASS | Synthetic hello re-registration |
| Corrupt result metadata | `tests/result-store.test.ts`, `c14-security-privacy.test.ts` | PASS | Temporary result store |
| Unrelated lease survives recovery | C14-A/B fixtures | PASS | Temporary coordinator namespace |
| Cancellation lifecycle | `tests/task-control.test.ts` | PASS | Owner CLI/source fixture |
| Repeated ambiguous recovery | `tests/c14-security-privacy.test.ts` and C14-E post-repair run | PASS | Bounded source workload |
| Queue disappearance / queued transport loss | coordinator queue and disconnect tests | PARTIAL | No dedicated gateway-to-queued-task transport fixture |
| Node process interruption | existing transport/recovery seams | PARTIAL | No dedicated child node process kill fixture |
| Worker process interruption | no direct source fixture | NOT MEASURED | Worker lifecycle proof would require a dedicated harness |
| Physical service restart or connector interruption | none authorized | BLOCKED | Installed service and connector mutation are outside this campaign |

## Required invariants

The passing fixtures assert stable task identity, exact node and actor identity, no duplicate synthetic effects, verified result/hash binding, AMBIGUOUS_EFFECT preservation, no blind replay, explicit reconciliation, unrelated lease survival, and temporary-state cleanup. No test targets an installed PID or production state directory.

## Remaining implication

The source recovery boundary is well covered for the implemented durable-task paths. The remaining partial rows require new process-boundary fixtures or owner-authorized installed/physical chaos. They do not justify changing production recovery code in this packet.
