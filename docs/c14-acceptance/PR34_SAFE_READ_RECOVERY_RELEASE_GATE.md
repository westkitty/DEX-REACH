# PR #34 — Safe Read Recovery Review and C14/C15 Gate

State: DRAFT / SOURCE-TESTED / NOT MERGED / NOT INSTALLED / PHYSICAL RECOVERY UNPROVEN.
Reference reviewed: westkitty/DEX-REACH PR #34, head bf8f1fccddd2cada5751599bd299d399751595f9.
Scope: isolated MacBook worktree /Users/andrew/DEX-REACH-recovery-20261117; exact node macbook-air.local.

## Authority and provenance
The current user instruction permits adversarial review and bounded branch repair, but expressly prohibits premature merging and installation. Live services, credentials, owner policy, iCloud, other machines, and the original dirty /Users/andrew/DEX-REACH checkout must remain unchanged. The installed immutable runtime is still 0.4.0-f7f59b35ebcd-191f252a5681, subject to a fresh readback at a future maintenance window.

## Adversarial review findings

- R34-01: The original boot runner marked certain refused tasks FAILED/CANCELLED/INPUT_REQUIRED and returned before deleting the private request descriptor. SUPPORTED by PR source. Repair: cleanup in an outer finally covering all exits; shared closed-task cleanup. New test verifies INPUT_REQUIRED purge and RUNNING retention, without affecting the task/evidence ledger.
- R34-02: A temporary coordinator status outage before read admission could throw out of the sole startup recovery pass and strand a RUNNING task. SUPPORTED by PR source. Repair: bounded retry of only typed pre-execution coordinator status/ticket-cancel failures; eight attempts with capped backoff, one logical task ID. Unexpected/post-execution errors are NEVER retried by this wrapper. New tests verify success after two outages, exact exhaustion and non-retry for unrelated errors.
- R34-03: Private descriptor cleanup did not revalidate the private directory before unlink. SUPPORTED; new directory guard. Existing symlink and file mode tests retained.
- R34-07: The original three-minute stale-lease timeout selected FAILED for an ACCEPTED task, an illegal ACCEPTED -> FAILED transition. SUPPORTED from source. Repair: legal-state mapping (ACCEPTED -> CANCELLED, PREPARING -> FAILED, RUNNING -> INPUT_REQUIRED), verified by a focused regression test. Physical timeout remains untested.
- R34-04: Optional recoveryAttempt preserves original schema-v1 attemptNumber=1; source compatibility passes current tests, but actual retained installed-runtime reader and rollback remain UNVERIFIED.
- R34-05: The public reach_task action=list is actor-restricted and bounded at source level, but the installed public MCP connector has NOT been refreshed or tested against the new schema.
- R34-06: Unknown-effect command/process replay remains refused by source and synthetic C14 tests; physical interruption is NOT proven.

## Source checks and hosted CI

Initial PR commit bf8f1fc: GitHub CodeQL SUCCESS (run 44220905778), reproducible-build SUCCESS and runtime-proof SUCCESS, but DEX validation FAILED (run 44220905513, job 134522191149): 1068/1069 tests passed, one test failed. The unrelated standalone native backend PDF write_pdf test timed out at 10 seconds waiting for a browser WebSocket endpoint. The cause is not independently reproduced. It is not permissible to waive, weaken or relabel a failed required job. New exact-head hosted checks will be required after repairs are pushed.

Bounded MacBook source tests: 57/57 focused recovery, security, orphan, task-store and MCP tests passed after repairs; new retry/cleanup tests passed 10/10. These are not physical start/kill/recover observations. TypeScript checks are separately required after final edits. The prior branch passed 42/42 invariants and build/native packaging, but results must be matched to final source head.

## Thirty official C14 gates: no 30/30 claim

The complete controlling definitions are in docs/releases/0.4.0-maintenance-window.md. None is automatically approved merely because this branch passes local tests. Status below is an advisory evidence inventory, NOT an executed preflight.

Identity group: EXACT_HOST, EXACT_ACCOUNT and EXACT_REPOSITORY were observed in a fresh node/worktree fingerprint. AUTHORIZED_BRANCH, CLEAN_SOURCE and REMOTE_PARITY still require a final clean post-merge main revision, not this draft branch. HOSTED_CHECKS is blocked by the original head's failed validation and requires all complete green final-SHA push checks. APPROVED_SHA, CANDIDATE_VERSION and CANDIDATE_RELEASE_IDENTITY require exact owner-approved immutable identity.

Runtime group: INSTALLED_IDENTITY was observed at the previous immutable version only. FIVE_SERVICES, RETAINED_PROVENANCE, LEGACY_COMPATIBILITY and RECOVERY_BASELINE need fresh exact-service, canary, prior-release and journal/rollback verification. The optional task field is NOT a physical downgrade proof.

Preservation group: BACKUP_COVERAGE, SYMLINK_POLICY, KNOWN_FAMILIES, SNAPSHOT_CONSISTENCY, INDEPENDENT_MANIFEST_TRUST, BACKUP_DESTINATION, BACKUP_DURABILITY and APPLICATION_RESTORE require a fresh quiescent certified inventory, encrypted independent destination, hash/readback verification and actual isolated restore. Existing iCloud / cloud placeholders are not backups by implication. No owner data was captured in this source pass.

Task group: NONTERMINAL_TASKS and TASK_DISPOSITION require a fresh complete count and reviewed owner acknowledgements; historical counts must not be copied. COORDINATOR_CLAIMS requires a fresh verified empty queue/lease ledger before the window, not one transient zero-lease snapshot. OWNER_PRESERVATION requires independent before/after evidence of policy, credentials, grants, historical task state and private paths.

Capacity group: FREE_SPACE requires measured candidate + dependencies + complete backup + restore + staging + at least 2 GiB reserve on source/destination volumes; a single MacBook reading of about 8 GiB is not sufficient. SYNTHETIC_RESTORE requires exact frozen-source test proof, and cannot substitute for actual stored owner-data restoration.

Authority group: MAINTENANCE_AUTHORITY remains explicitly absent in this task; current instructions prohibit installation and merge. No window may start until a distinct owner-approved window and exact candidate are recorded.

## C14 physical interruption acceptance — only within an authorized window

0. Freeze exact post-merge main SHA/lock/version/runtime ID and independently passing hosted CI, audit and build-provenance receipts.
1. Obtain explicit maintenance window, approved retained rollback runtime and independent encrypted backup destination. Reconcile current active jobs, queue and historical ambiguous/quarantine dispositions. Stop on uncertainty.
2. Quiesce the five live service routes using the repository-native procedure; capture complete owner state offline and prove independent manifest and isolated real-data restore. Preserve originals/revisions.
3. Run the official 30/30 C14 preflight from a clean, approved main checkout. NO installation without all 30 actual results passing.
4. Use the existing immutable macOS installer, recording rollback metadata and exact service/node source identity. Verify current policy, five services, OAuth route, public MCP contract and Control Room.
5. Perform the existing A-E physical chaos scenarios: gateway loss after start, node killed during a process, coordinator killed with lease, worker killed, and four-service restart. Unknown external effects may remain AMBIGUOUS, never auto-replayed.
6. Add PR #34 safe-read scenarios: controlled long-enough benign durable read, confirm RUNNING before node kill, recover under same task ID and actor/node/policy, check bound retry count, verified result hash, and no duplicate coordinator lease. Repeat for old lease/ticket and gateway disconnect. Instant fingerprint calls alone cannot prove RUNNING interruption.
7. Verify reconnect discovery with a different authenticated client session using reach_task list/get/result; wrong-client and wrong-node calls must refuse. Confirm actual hosted MCP schema has the list action.
8. Test policy set OFF after preparation, coordinator unavailable through retry limit, malformed private descriptor, stale/uncertain lease, mutation/shell no-replay; reconcile task/event/result/trace evidence without guessing.
9. Prove C13 rollback from original journal and source trust, verify old reader compatibility and service health; forward-install only by a separate authorized transaction, and repeat restart proof. Verify local Control Room, OAuth and client-facing UI before releasing maintenance.
10. Stop at any failed gate, changed source identity, failed restore, ambiguous mutation, unverified lease/rollback or lost OAuth/connector route. Never patch a running immutable release or blind-replay a timeout.

## C15

BLOCKED. C14 program acceptance, release pin, security/CI, clean-build/source proof, installed runtime/rollback, public connector refresh, Control Room human acceptance and cross-DEX conformance must all be proven independently. Source commits and a draft PR do not promote installed state.

The review does not authorize merge, install, service restart, credential/grant/root changes, historical task cleanup, Big Mac actions, iCloud settings, or automatic owner-data backup/deletion.
