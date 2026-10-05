# ADR-0002 — Operation Safety Classes, Retry Policies, and Reconciliation Semantics

Status: Accepted
Date: 2026-10-05
Decision owners: DEX//REACH project

## Context

Distributed AI agent execution frequently encounters transient network disconnects, caller timeouts, service restarts, and delayed process completions. In naive systems, clients or gateways automatically retry requests upon timeout. However, when an operation executes shell commands, edits code, runs builds, or commits Git changes, blind replay causes catastrophic double-execution, branch divergence, dirty worktree corruption, and unintended side effects.

To make DEX//REACH execution durable and safe, we must formalize operation safety classes, idempotency key handling, retry eligibility, uncertainty boundaries, and mandatory reconciliation protocols.

## Decision

### 1. Operation Safety Classification

Every operation dispatched through DEX//REACH must declare its safety class in its tool/command manifest. Operations fall into exactly five exhaustive classes:

| Safety Class | Mutation Level | Side Effects | Automatic Retry Permitted? | Uncertainty Behavior |
| :--- | :--- | :--- | :--- | :--- |
| `PURE_READ_IDEMPOTENT` | `NONE` | Zero. Pure read/inspect. | **YES** (with bounded backoff) | Safe to re-read. |
| `SIDE_EFFECTING_IDEMPOTENT` | `STATE_MUTATION` | Mutations present, but repeated execution with identical arguments produces identical end-state without compounding. | **YES** (ONLY with identical `idempotency_key` and pre-execution state check) | Verify state before retry. |
| `PLAN_COMMIT` | `STAGED_MUTATION` | Exactly-once two-phase planned mutation (`DEX-INV-010`, `DEX-INV-020`). | **NO** (Blind retry forbidden; claim token is one-use) | Transitions to `AMBIGUOUS`. Requires receipt check. |
| `PROCESS_UNKNOWN_EFFECT` | `ARBITRARY_MUTATION` | Subprocess, shell execution, scripts, tests, builds. Non-idempotent by default. | **NO** (Automatic retry strictly FORBIDDEN) | Transitions to `AMBIGUOUS`. Requires reconciliation. |
| `DESTRUCTIVE` | `PERMANENT_DELETION` | Non-invertible data deletion, reset, file wipe, external release. | **NO** (Automatic retry strictly FORBIDDEN) | Transitions to `AMBIGUOUS` or `FAILED`. |

### 2. Idempotency Key Semantics

Callers may supply an `idempotency_key` (UUIDv4 or SHA-256 string). If omitted, the node derives an idempotency token from the cryptographic SHA-256 hash of the canonicalized input parameters.

#### Idempotency Scope
Idempotency keys are strictly scoped to the tuple:
```text
(actorId, nodeId, operationName, idempotencyKey)
```
An idempotency key used by Actor A cannot conflict with or claim a task submitted by Actor B.

#### Duplicate Submission Behavior
When a submission presents an existing `(actorId, nodeId, operationName, idempotencyKey)`:
1. **Payload Matching Check**: The node compares the inbound payload hash against the recorded task's initial payload hash.
   - If the payload differs: Node **fails closed** immediately with error `IDEMPOTENCY_KEY_COLLISION_MISMATCH`. It does NOT execute or overwrite.
2. **State-Dependent Handling**:
   - If existing task is in `ACCEPTED`, `PREPARING`, or `RUNNING`: The node returns the existing `taskId` and its current status. No duplicate execution is spawned.
   - If existing task is `COMPLETED`: The node returns the cached completion receipt and result reference immediately with `isDuplicate: true`.
   - If existing task is `FAILED` or `CANCELLED`: The node returns the recorded terminal outcome without re-executing.
   - If existing task is `AMBIGUOUS`: The node returns the ambiguous status and advises reconciliation; it does NOT spawn a new run.

### 3. Retry Attempt Budgets and Accounting

- Every task maintains an `attemptNumber` counter (starting at 1) and an `attemptBudget` (default: 3 for `PURE_READ_IDEMPOTENT`; 1 for `PROCESS_UNKNOWN_EFFECT` and `DESTRUCTIVE`).
- Every attempt is recorded as an immutable event in the task event log with timestamps and failure reasons.
- **Authority and Budget Invariance**:
  - A retry attempt CANNOT widen execution authority (`DEX-INV-002`, `DEX-INV-030`).
  - Rolling execution budgets (`DEX-INV-029`) track resource consumption across all attempts. If a task's retry would exceed the caller's rolling operation or token ceiling, the retry is refused with `BUDGET_EXHAUSTED`.
  - An owner approval or capability grant applies to the task instance, not to unlimited retries.

### 4. Uncertainty Rules and the AMBIGUOUS State

When execution status cannot be authoritatively proven by the node (e.g., child process pipe broke, node restarted mid-execution, remote API call timed out without response):
1. **The Universal Rule**: A client/network timeout DOES NOT prove that execution stopped.
2. **Process Execution Uncertainty**: A spawned OS process may still be executing in the background even if the parent transport disconnected. The node must check process table existence (`PID`) and exit status before presuming failure.
3. **Git Worktree Uncertainty**: File mutations or Git index operations might have left partial writes or `.git/index.lock`. Blind replay risks committing corrupted intermediate states.
4. **Mandatory AMBIGUOUS Transition**: Whenever an active task encounters an unresolvable disconnect or unexpected process termination during a mutating or unknown-effect operation, it MUST transition to `AMBIGUOUS`.
5. **No Blind Replay**: Under NO circumstances may an autonomous agent or retry worker replay a task marked `AMBIGUOUS` without completing a reconciliation pass.

### 5. Reconciliation Protocols

Reconciliation is the formal process of inspecting ground-truth reality to resolve an `AMBIGUOUS` task into a deterministic terminal state (`RECONCILED`, `COMPLETED`, or `FAILED`).

#### Reconciliation Step Ladder
1. **Process Liveness Probe**: Inspect OS process table for the recorded child PID.
   - If PID is alive: Attach monitoring listener, await process completion or termination. Task returns to `RUNNING`.
2. **Artifact & Receipt Probe**: If PID is dead, inspect target filesystem, output files, and execution receipts (`DEX-INV-011`).
   - If deterministic completion receipt exists with valid cryptographic signature: Verify outcome and transition task to `RECONCILED` with result payload.
3. **Workspace State Probe**: For Git or filesystem operations, run read-only `git status --porcelain` and `git diff` against expected `baseSha`.
   - If expected mutations are fully in place: Transition to `RECONCILED`.
   - If partial, corrupt, or unexpected mutations are detected: Transition to `FAILED` (reason: `PARTIAL_EXECUTION_DETECTED`) and advise human operator intervention.
4. **Human Operator Resolution ("Needs Andrew")**: If automated probes cannot deterministically verify state, surface the task to the local Control Room with an impact preview for human decision (Resume, Reconcile, or Cancel).

## Consequences

### Positive
- Prevents double-execution of non-idempotent scripts, builds, and commits.
- Protects Git repository integrity and prevents worktree corruptions.
- Enforces strict accounting of rolling budgets across execution attempts.
- Guarantees compliance with `DEX-INV-010`, `DEX-INV-011`, `DEX-INV-020`, `DEX-INV-029`.

### Costs / Tradeoffs
- Operations in `PROCESS_UNKNOWN_EFFECT` require reconciliation rather than immediate automatic retry, requiring callers to handle `AMBIGUOUS` responses.
- Idempotency key registry requires persistent indexing on the node.

## Validation
1. Fixture tests validating correct safety class assignments.
2. Negative fixture tests demonstrating rejection of automatic retry on `PROCESS_UNKNOWN_EFFECT` and `DESTRUCTIVE`.
3. Negative fixture test demonstrating rejection of duplicate submissions with mismatched payload hashes.
4. Negative fixture test demonstrating rejection of tasks falsely claiming `COMPLETED` when outcome was uncertain.

## Revisit When
- OS containerization provides zero-overhead copy-on-write filesystem transaction snapshots for arbitrary processes.

## Supersedes
None. (Foundational ADR for Phase C1).
