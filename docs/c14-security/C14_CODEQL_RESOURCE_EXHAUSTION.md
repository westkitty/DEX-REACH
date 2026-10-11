# C14 security closure — CodeQL js/resource-exhaustion (alert 10) and pre-execution task ambiguity

Scope: source repair on `c14-chaos-recovery` from clean `0d257c722a715961f029d9890dc03941f1863ccb`, plus read-only live task provenance. Nothing installed, restarted, enabled or mutated. C13 NOT PASS; E7 HOST CAPABILITY BLOCKED; C14 program PARTIAL; C15 BLOCKED.

## Alert

GitHub code scanning alert 10. Rule `js/resource-exhaustion` (CWE-400, CWE-770), security severity **high**. First instance on PR merge commit `7b7fcba21d3c` (`refs/pull/16/merge`); failing check run 114224293866. Location: `src/shared/checkpoint.ts:115:57`. Message: "creates a timer with a user-controlled duration from a user-provided value." It is the only alert introduced by this PR; alerts 1–6 are older `main`-branch alerts in unrelated files. The alert was not dismissed or modified.

## Root cause

- **Source:** JSON requests parsed from the participant control socket (`enableProcessCheckpoint`).
- **Sink:** the drain-deadline `setTimeout(..., input.drainMs)` in `CheckpointParticipant.prepare`.
- **Missing bound:** `holdMs` had an absolute ceiling (15 minutes). `drainMs` was bounded only relative to another peer-supplied value (`drainMs <= holdMs`), so the participant enforced no ceiling of its own.
- **Demonstrated on the vulnerable revision:** a peer-chosen 10-minute drain was armed (`ARMED_AND_WAITING`), and node admission stayed `CHECKPOINT_ADMISSION_CLOSED` for its duration.
- **Severity in practice:** the peer must reach the owner-only socket, and only one hold can exist at a time. The defect is real nonetheless: the participant, not the peer, must own its timer budget.

## Repair

- **Participant-owned ceilings:** `CHECKPOINT_MAX_HOLD_MS` (15 min) and `CHECKPOINT_MAX_DRAIN_MS` (60 s).
- **Validated durations only:** each duration passes `boundedDuration` (a safe integer between an absolute minimum and the constant maximum) before any timer is armed. Timers receive only these values, never the raw request fields.
- **Nothing loosened:** the existing `drainMs <= holdMs` check is kept. The holder's default drain (3 s) and all protocol checks are unchanged.
- **Regression:** `tests/c14-checkpoint-evidence.test.ts`, "CodeQL js/resource-exhaustion #10". It requires `CHECKPOINT_REQUEST_INVALID` for a 10-minute drain, a hold over the ceiling, and negative, fractional, NaN and over-ceiling drains. It also verifies admission never closes and that the legitimate path still acknowledges.
- **Sibling timers:** the holder's connection and response timers come from the trusted caller's configuration, not from peers.
- **No local CodeQL CLI exists.** The hosted CodeQL check on the final revision is the deciding gate.

## Live task provenance (read-only)

Status vocabulary: OBSERVED = read directly from installed state; INFERRED = deduced from consistent evidence; UNVERIFIED = evidence missing; CONTRADICTED = disproved by evidence.

- **OBSERVED:** 19 nonterminal records out of 682. 17 are PREPARING with failure class AMBIGUOUS_EFFECT and 2 are RUNNING pure reads (`dex.file.read`). None has a result reference. Every live record carries a real connector actor identity; none is synthetic.
- **OBSERVED:** the two records added today were created at 12:55:56Z and 12:57:16Z, which is 08:55:56 and 08:57:16 EDT; the host clock reads EDT = UTC−4. Both are `dex.process.run` with `PROCESS_UNKNOWN_EFFECT`, attempt 1.
  - Their events show acceptance, then PREPARING, then about 120 `WAITING_FOR_COORDINATOR: substantive slots exhausted (1/1, including 1 uncoordinated heavy workload(s))` updates, then `Task stopped: AMBIGUOUS_EFFECT.` about 60 s later. They never reached RUNNING.
  - The installed audit log attributes both to ChatGPT connector requests. The node logged `COORDINATOR_WAIT_TIMEOUT`. The gateway logged `node request timed out after 60000ms` about 0.4 s *before* the node's definite refusal.
  - The earlier statement that these records came from "connector activity" is therefore **confirmed**, and the earlier creation times (08:56 and 08:58) were the *update* times; creation was a minute earlier.
- **CONTRADICTED:** that this campaign's tests created them. Their actor is the connector actor, the audit source is the gateway's ChatGPT client, and this session made no DEX//REACH tool calls. Tests use minted synthetic roots and synthetic actors.
- **OBSERVED, current:** the capacity classifier (`HEAVY_COMMAND_PATTERNS`, `\bclaude\b`, with CPU ≥ 10 or memory ≥ 2%) counts the running Claude desktop-app processes as uncoordinated heavy workloads, and this host has one substantive slot.
- **INFERRED:** that the slot holder at 12:55Z was the desktop app, or this session's concurrent `tsc` / `node --test` runs (12:55:51–12:58Z). The coordinator does not persist which process occupied the slot, so the exact process is **UNVERIFIED**.
- **OBSERVED:** the other 3 of today's records show the same signature: 1 `dex.process.run` and 2 `dc.call` at about 04:10Z.
- **INFERRED, not verified:** the 12 older PREPARING records (Oct 6–9) share the same state and failure-class signature, and boot recovery later annotated them "had not reached execution and no live execution evidence remains". Their original events were truncated by the event log's 2,000-line retention.
- **UNVERIFIED:** the two RUNNING pure reads (Oct 8) have no surviving events, no result reference and no live lease.

No record was changed, cancelled, completed, retried or replayed. Without a task-bound effect oracle their classifications remain AMBIGUOUS_EFFECT or INSUFFICIENT_EVIDENCE.

## Prevention defect (source-repaired; existing records untouched)

The repair corrects two defects in the node's error path (`src/node/main.ts`), reproduced in `tests/c14-pre-execution-failure.test.ts`:

1. **Misclassification.** A failure before the durable RUNNING transition was classified by safety class, so `COORDINATOR_WAIT_TIMEOUT` on an unknown-effect operation became AMBIGUOUS_EFFECT. Execution only begins after RUNNING is committed, so such a task provably never ran.
2. **Records left nonterminal.** The handler then attempted PREPARING → AMBIGUOUS, which the task store forbids (PREPARING allows RUNNING, CANCELLED or FAILED), and the error was swallowed. The record stayed PREPARING forever.

The fix: `unstartedFailureOutcome` (`src/shared/durable-execution.ts`) applies only when execution was not started and the persisted state is ACCEPTED or PREPARING.
- The failure is classified as a definite non-execution (`TRANSIENT_RESOURCE` for coordinator capacity; never AMBIGUOUS_EFFECT), and PREPARING ends terminal FAILED.
- ACCEPTED keeps its state, because ACCEPTED → FAILED is illegal.
- Once execution may have started, behaviour and uncertainty are exactly as before. `retryAllowed` still refuses automatic retry for unknown-effect, destructive and plan operations; no replay authority changes.

The fix applies only to future failures after a separately authorized install; the 19 existing records are preserved as they are.

## Not repaired (owner decisions)

- **Timeout race:** the gateway's 60 s request timeout equals the node's 60 s lease deadline, so clients can see a timeout instead of the definite refusal.
- **Capacity classification:** the desktop app counts as a permanent heavy workload on this one-slot host. Tuning the capacity policy (`\bclaude\b` patterns, slot counts) is an owner policy choice.
- **Event log retention:** 2,000 lines drops evidence for older nonterminal records.

## Validation

`npm run verify` exit 0: typecheck, 42/42 invariants, 640/640 tests (0 fail, cancelled or skipped), build, audit at the unchanged high threshold (six moderate advisories), 26-tool probe, `git diff --check`.

Inside that run all 32 multi-process checkpoint scenarios (21 real-process plus 11 forged participants) and the evidence and gate suites passed. Hosted CodeQL for the final revision is recorded below from the owning check run, not inferred from local tests.

## Scheduler/admission continuation — 2026-10-10

The earlier source receipt above remains historical. Future-source timeout, capacity and bounded
retention repairs, legal ACCEPTED → CANCELLED failure handling, synthetic integration evidence and
measurement limitations are recorded in [C14 scheduler/admission repair](C14_SCHEDULER_ADMISSION_REPAIR.md).
The 19 unresolved installed records remain untouched; source repair is not installed acceptance.
