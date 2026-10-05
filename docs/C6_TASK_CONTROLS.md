# C6 owner controls and continuation contract

The owner CLI is the local control surface for durable task evidence. It extends the existing
`tasks` and `task <id>` inspection commands without changing the 16 existing MCP tools or
executing an installed runtime.

## Commands

- `dex tasks` lists durable task snapshots.
- `dex task <id>` shows the task identity, lineage, state, trace id, and `NEEDS ANDREW` decision
  when the task is waiting for input or reconciliation.
- `dex task <id> events` reads the append-only content-free lifecycle ledger.
- `dex task <id> log` produces DEX//LOG: task state, lifecycle events, phase/activity evidence,
  audit candidates, signed receipt candidates, trace linkage, and the current policy revision.
- `dex task <id> result` reads only the task-bound, hash-checked result reference.
- `dex task <id> cancel`, `pause --after-phase PHASE`, and `resume` re-check the current owner
  policy before recording the control. Pause is a boundary request; worker acknowledgement remains
  observable and is never inferred.
- `dex task <id> reconcile --evidence-ref REF` is permitted only for `AMBIGUOUS` tasks and requires
  a bounded evidence identifier. It does not manufacture a result.
- `dex task <id> retry` is permitted only when the existing safety/failure classifier permits replay.
  Uncertain-effect, destructive, authority, invalid-input, and corrupt-state failures are refused.
- `dex task <id> reset` archives the old terminal task and creates a linked child with preserved
  root lineage and immutable old evidence.
- `dex task <id> continuation [--out FILE]` emits a compact JSON handoff containing verified local
  state, event history, activity evidence, result reference metadata, and explicit UNKNOWN links
  for Git, hosted CI, deployment, and installation when no owning evidence is present.

Consequential `restart`, `rollback`, and `kill` controls support an impact preview only in this
campaign. Even with a confirmation token they refuse execution; fixture/temp-process coverage is
the boundary, and no production-like runtime is controlled.

## Evidence rules

Task events contain identifiers, state transitions, classifications, hashes, bounded summaries,
control names, and evidence references. They do not contain request payloads, result bodies,
credentials, process output, or chain-of-thought. Audit and receipt records are shown as candidates
unless they carry an exact task link. DEX//TRACE follows the recorded task trace id; a missing link
is reported as `UNKNOWN`, never guessed from timing or operation name.
