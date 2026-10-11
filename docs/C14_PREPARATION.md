# C14 preparation — phase entry remains blocked

> Current-state note (2026-10-10): this is a historical C13 phase-entry preparation packet. Its original authorization statement is not the current source-development authority. C14-A through C14-F source work and evidence now live in `docs/C14_EVIDENCE.md`; C13 remains NOT PASS and E7 remains BLOCKED — HOST CAPABILITY. The original requirements and missing-master-plan limitation below are preserved.

State: PREPARATION ONLY. C13 NOT PASS while E7 remains BLOCKED — HOST CAPABILITY. No C14 implementation or C15 work is authorized by this packet.

## Planning authority

The locally available accepted requirement map is `/Users/andrew/dex-c13-recovery/docs/architecture/control-system/REQUIREMENT_MAP.md`, section 10, REQ-C14-001 through REQ-C14-009. It names `DEX_Control_System_Master_Plan.docx` as governing source. That original DOCX was not located in the inspected repositories, attachments, Documents or Downloads. Verify it before final C14 scope selection; this packet does not invent missing requirements. The checked-in C13 gate and recovery evidence in the same directory require genuine host evidence before phase entry. Other DEX checkouts contain older evidence and must not supersede current REACH runtime observations.

## Entry conditions

Require genuine C13 closure including owner-authorized running-task connector interruption/re-enable and same-ID survival proof. Retain fresh E4 independently. Resolve source, branch, exact published SHA and its hosted checks; require owner approval for any physical chaos window. Ordinary source tests run in isolated temporary state, never against owner task stores, active services or another product's state.

## First coherent packet after entry

Start with REQ-C14-001/002/009: isolated loss of a response after result persistence, then restart/reopen and read the same task/result without executing again. Extend existing durable-execution and boot-recovery tests into one real isolated node/gateway harness. Add a controlled fixture for mutation-before-response whose missing durable outcome remains AMBIGUOUS and forbids retry. Capture a regression fixture for each demonstrated defect. Do not start with physical service kills or an unbounded stress suite.

| Source owner | Existing implementation / test starting points | Required observations |
| --- | --- | --- |
| Node durability | `src/node/task-store.ts`, `result-store.ts`, `boot-recovery.ts`; `tests/durable-execution.test.ts`, `task-recovery.test.ts` | one task ID, persisted reference/hash, execution counter exactly one, no replay |
| Recovery classification | `src/shared/durable-execution.ts`, `task-recovery.ts` | uncertain mutation remains visible and retry refused |
| Transport | `src/node/main.ts`, `src/gateway/main.ts`; `tests/routing.test.ts`, `node-transport-auth.test.ts` | explicit isolated node, delayed/dropped response, reconnection with same ID |
| Coordination | `src/coordinator/client.ts`, `main.ts`, `src/shared/work-coordinator.ts`; `tests/coordinator-daemon.test.ts`, `coordinator-disconnect.test.ts` | normal release, refused forged release, bounded queue cleanup and no leaked claims |

Dependencies: existing Node/TypeScript/tsx/WebSocket test infrastructure and private temporary state; no new dependency proposed. Preserve node-local OFF/read-only policy, exact node/no fallback, grants/budgets, failed/ambiguous history, immutable release recovery and share-safe projections.

Focused acceptance: the harness demonstrably executes once, loses the first response, retrieves the same persisted result after restart, refuses replay for uncertain mutation, and removes only its own temporary claims. Follow with repository-required verification and exact-head hosted CI; source success is separate from physical chaos acceptance. Other C14 map requirements remain separate future packets: performance baseline, bounded long-session stress, security/privacy regressions, mixed-version matrix, cold-start recovery. No performance target or timing threshold is fabricated here.
