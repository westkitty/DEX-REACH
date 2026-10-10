# C14 production writer checkpoint — architecture and evidence

Scope: source engineering and isolated multi-process synthetic proof on `c14-chaos-recovery`, starting from verified clean `97bd901e40215bdc6a30fe42ca43d2f0c7f57569`. Nothing here was activated on the installed runtime. C13 NOT PASS; E7 HOST CAPABILITY BLOCKED; C14 program PARTIAL; C15 BLOCKED.

## Why locks alone are insufficient

Most writers serialize through `withFileLock` (`src/shared/state-io.ts`). A holder that takes those same locks closes admission and drains in-flight work across processes. Two facts make that insufficient on its own:

1. **Multi-lock operations.** `NodeTaskStore.transition` commits `tasks/store.json` under `store.lock`, releases it, then appends `tasks/events.jsonl` under its own lock. A lock-only checkpoint can land between them and capture a store ahead of its events.
2. **Lock-free writers.** OAuth persists through an in-memory queue (`src/gateway/auth.ts`); audit appends without a lock (`src/shared/audit.ts`); deferred durable-task execution continues after its request returns (`src/node/main.ts`); node status and plan sweeps run on timers.

So quiescence is two-layered: an operation-level **participant gate** inside each long-running writer process, then a **lock fence** for every other process that mutates through the shared locks.

## Writer ownership matrix (as implemented)

Source of truth: `WRITER_OWNERSHIP` in `scripts/lib/recovery-checkpoint.ts`; `ownershipBlockers()` refuses any unregistered, duplicated or quiescence-less group. Lock paths are the writers' own helpers, pinned by test.

| Group | Owning processes | Serialization / persistence | Checkpoint quiescence | Detected, not prevented |
| --- | --- | --- | --- | --- |
| tasks-results-events | node (request + deferred execution), CLIs | `tasks/admission.lock`, `store.lock`, `events.jsonl.lock`, `results/results.lock`; atomic replace | node participant drain + lock fence | — |
| receipts | node | `receipts/<node>.lock`; signed append | node participant + lock fence | — |
| coordinator | coordinator daemon, node heartbeats, status readers | `coordinator.lock`, `history/events.lock`, `capacity-profile.lock`; atomic lease/ticket files | lock fence; any lease or ticket refuses admission | — |
| policy-grants-budgets-plans | node, CLIs | access, budget, capability-request, policy-assertion, secrets locks; access-before-budget order | node participant + lock fence | plan claim files (exclusive create, no shared lock) |
| enrollment-revocation | gateway, CLIs | `node-auth.json.lock` + in-process exclusive queue, `revoked-nodes.json.lock` | gateway participant + lock fence | — |
| oauth | gateway | in-memory state, `persistQueue`, atomic replace; no lock | gateway participant (persistence **deferred** while held) | — |
| runtime-installer | install/rollback/reload scripts | journals and release staging; no admission lock | installer-process absence + content comparison | everything (no lock exists) |
| activity-audit-trace-checkpoints | node, gateway | `activity/processes.lock`; audit append; per-trace locks + async span flush | participants (`track`) + activity lock | async trace flushes |

Every "detected, not prevented" change is caught by the holder's before/after content comparison and refuses certification.

## Participant gate (`src/shared/checkpoint.ts`)

IDLE by default: `processCheckpoint()` returns a frozen object whose methods are direct calls. Participation exists only after `checkpointControlFromEnv` sees `DEX_REACH_CHECKPOINT_CONTROL=1`. Installed LaunchAgents do not set it; enabling it is a separately authorized maintenance change. The gateway also requires an explicit `DEX_REACH_CHECKPOINT_NODE_ID`.

- `admit` — new requests (node dispatch). Refused **before execution** with `CHECKPOINT_ADMISSION_CLOSED`, so no state changes.
- `track` — continuations of admitted work (deferred task execution, audit appends). Never refused, always drained, counted in the generation.
- `defer` — background persistence (OAuth). Waits for release.
- `skipWhileHeld` — periodic best-effort work (status publish, plan sweep). Skipped, not queued.

`prepare` closes admission, drains in-flight work within `drainMs` (a timeout reopens admission and refuses: `DRAIN_TIMEOUT_OPERATION_MAY_CONTINUE`), then signs an acknowledgement. Work failing inside the drain window counts as a fault and the holder refuses. Holds expire after `holdMs` and are released when the holder's connection closes. Every message carries role, node, groups, pid, a per-process `bootId`, and the participant's state root (real path, device, inode). Each message is signed with a per-process Ed25519 key delivered in the hello on the same owner-only socket.

## Holder protocol (`scripts/lib/recovery-checkpoint.ts`)

1. **PREPARE:** take the exclusive `holder.lock` (a contender is refused with `CHECKPOINT_CONTENDED`; a dead holder's lock is recoverable). Record `PREPARED`. Refuse on any coordinator lease or ticket, a running installer, or task activity evidence. Stale nonterminal records are counted, preserved and never resolved.
2. **CLOSE ADMISSION / DRAIN / COLLECT:** hello and prepare each required participant, then verify signature, role, node, groups, state root, pid, boot, transaction, nonce, zero in-flight and zero drain faults. A missing, unresponsive or forged participant, an unsolicited or duplicated reply, or a refusal all refuse. Record `ACKNOWLEDGED`.
3. **FENCE:** take every registered writer lock in canonical order, each with a timeout (`WRITER_LOCK_UNAVAILABLE`, never a deadlock). Record `FENCED`.
4. **VALIDATE GENERATION:** observe the closed-world coverage manifest; only the holder's own verified locks are exempt. Write the **independent expectation** (manifest digest plus combined writer generation) before any byte is copied.
5. **CAPTURE:** the existing `captureSynthetic`. Its boundary owner re-attests every participant (still held, same boot, same generation, nothing in flight) and re-observes content at each validation point.
6. **VERIFY:** digest the destination's actual bytes, re-attest, record `CAPTURED`, compare with the expectation store, record `RESTORE_VERIFIED` (application-level restore from the existing rehearsal), then `CERTIFIED`.
7. **RELEASE OR RECONCILE:** explicit release, plus release on connection close. Any failure before capture is `REFUSED`; any failure after capture starts is `FAILED_UNCERTAIN`.

## Durable evidence contract (`scripts/lib/recovery-evidence.ts`)

- **Transaction log:** per-transaction directory of exclusively created, fsynced, hash-chained records bound to node and transaction. Legal transitions only; tampering, gaps, reordering, overwrite and cross-node reads refuse.
- **Expectation store:** a separate private root that must not overlap the log, the destination or the source. It is written once, before capture.
- **Artifact digest:** computed from the destination's bytes, modes, links and directory membership, never from the manifest.
- **Reconciliation after restart:** `CERTIFIED_VERIFIED` only when the artifact still matches the recorded digest *and* the independent expectation. An interrupted chain is `UNCERTAIN_INTERRUPTED` even when its artifact is intact. `retryAuthorized` and `installationAuthority` are always `false`.
- **Contents:** records hold identities, digests and public keys only; no payloads, credentials or secret material. No live evidence store exists.

## Remaining live limitations (precise missing capabilities)

- **Not activated.** Participation is not enabled in any installed process. Doing so needs an approved LaunchAgent environment change plus restart. Not authorized.
- **Capture is synthetic only.** `liveCapture()` still refuses, and all ten live boundary gates remain false.
- **Coordinator daemon** has no participant. It is fenced by its locks, and any live lease or ticket refuses admission. Two writes previously escaped that fence and were repaired: capacity health (`capacity-profile.lock` was not fenced), and `workStatus` reclaiming expired leases and tickets without `coordinator.lock`, so a status read could delete coordinator files while another holder owned the lock. During a checkpoint, status reads now wait (bounded at 15 s) instead of mutating. Regressions: `tests/c14-coordinator-fence.test.ts`.
- **Installer and rollback scripts** have no admission lock. Quiescence is process absence plus content comparison.
- **Plan claims and asynchronous trace flushes** are detected, not prevented.
- **Cross-volume destinations** still fail closed on volume identity.
- **Live task records:** the 19 unresolved live records (17 at the start of this campaign) would be preserved, not resolved. The two RUNNING records currently carry no activity evidence. A live window still requires fresh read-only evidence and owner disposition first.

## Multi-process proof (`tests/c14-checkpoint-production.test.ts`)

Each test runs separate OS processes: a holder that owns a minted synthetic workspace, a real node participant and a real gateway participant (production `NodeTaskStore`, `ResultStore`, `TaskEventLog`, `appendReceipt`, `AuditLog`, `updateAccessState`/`createGrant`, `addRevokedNode` and `ReachOAuthProvider`), and short-lived CLI writers that use the same production locks. Child processes refuse to start without a synthetic state root. 32/32 pass:

- **Certified and consistent:** a result committed just before admission closed; an event append racing the checkpoint (drained, so store and events are captured together); a receipt from an in-flight operation (the acknowledgement waits for it); a revocation before the fence (captured); a revocation or grant attempted inside the fence (blocked, outside the snapshot); OAuth persistence while held (deferred, outside the snapshot, persisted after release); stale nonterminal tasks preserved byte-identical, with `replayAuthorized=false`.
- **Refused or FAILED_UNCERTAIN, never certified:** a writer that never responds (SIGSTOP, so UNRESPONSIVE, not "stopped"); a writer dying mid-drain; a participant restarted with a new identity; a failure partway through an in-flight operation (drain fault); a writer that committed state without its event (refused by the application restore); capture failing after every acknowledgement; an unexpected coordinator lease during capture; a gateway audit append after acknowledgement (generation changed); an unregistered raw write (captured consistently if it landed before the manifest, otherwise refused); a hung operation (drain timeout reopens admission); a missing participant; a running installer; a coordinator claim; two holders contending (`CHECKPOINT_CONTENDED`).
- **Holder loss:** a holder that crashes after capture leaves `UNCERTAIN_INTERRUPTED` with the artifact `PRESENT_UNRECORDED`, no retry, and admission reopened. A holder that crashes while holding admission releases it through connection close. A new holder recovers the dead holder's lock but is refused for participants serving another state root (`WRITER_STATE_MISMATCH`).
- **Forged participants (11), each refused for its pinned reason:** a different signing key, another transaction, a forged nonce, a stale boot identity, a different pid, work still in flight, a changed generation on re-attestation, a duplicated acknowledgement, another node, unowned groups, a substituted hello key.

`tests/c14-checkpoint-evidence.test.ts` (19) covers the chain: append-only enforcement; tampering, gaps and reorder; cross-node substitution; artifact substitution, including edits to the private manifest or receipt and planted top-level files; a missing independent expectation; interrupted states; root privacy and overlap. It also covers the ownership matrix, the IDLE gate, participant semantics, the control directory, fixed refusal codes, socket displacement, lock paths pinned to the writers' own helpers, and the live gates staying false.

## Performance effect

Matched synthetic workloads, measured standalone. A gate call (200,000 iterations): direct 852–1,008 ns, IDLE gate 822–957 ns, enabled-open gate 1,766–1,871 ns. So the idle gate adds nothing measurable, and enabled participation costs about 0.9 µs per operation. A real durable-task workload (create plus two transitions with events, median of 40): direct 67.4 ms, IDLE 64.0 ms, enabled-open 65.9 ms, which is within noise. Measurements inside the loaded full suite are noisier (172.8, 174.6 and 196.6 ms) and are not used as a baseline. No new timer, socket, file or lock exists while IDLE.

## Adversarial review

Self-review found that participant identity did not bind the state root, which would let a holder accept acknowledgements from writers of another state directory. It also found that the holder's own lock under an in-state control directory would always block coverage. Both were repaired with regressions. Implementation also tripped the existing secret-broker import invariant; the holder now spells the secrets lock path out, pinned by test, instead of importing the broker.

An independent read-only review (it reasoned from code and executed nothing) found no certification bypass. It reported:

- **Artifact digest scope:** the digest omitted the transaction's private manifest and receipt. Repaired: the whole transaction directory is digested.
- **Socket displacement:** a second participant could unlink a live socket. Repaired: it is refused with `CHECKPOINT_SOCKET_IN_USE`, and the claimed pid must be alive.
- **Raw error text in evidence and outcomes:** repaired with fixed codes only.
- **Unkeyed chain:** documented. `CERTIFIED_VERIFIED` means internally consistent against the independent expectation store, not attested against someone able to write both private roots.

Two other observations were checked and left unchanged: the node dispatch catch and the timer `.catch` handlers exist at the starting revision, and the in-state `checkpoint` directory's contents are closed-world checked (a non-socket entry is UNKNOWN).
