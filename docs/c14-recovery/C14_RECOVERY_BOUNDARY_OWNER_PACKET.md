# C14 recovery boundary closure — owner decision packet

Scope: source engineering and isolated synthetic data. This extends the [existing recovery foundation](C14_RECOVERY_READINESS.md); it does not authorize maintenance. Starting source was clean local/remote `cd167b81ad65c21900e7f2d06e12c25cbf9b84c7` on `c14-chaos-recovery`, in `/Users/andrew/dex-reach-c13-worker-repair`, MacBook-Air.local / MacBookAir10,1 / darwin arm64 / andrew UID 501. PR16 must remain draft/open/unmerged with base `c13-worker-repair`.

## Source changes and actual limits

The existing coverage, rehearsal, reconciliation and twenty-prerequisite preflight remain the owners. Added modules implement governed links, a synthetic writer checkpoint contract, destination admission, allocation budgeting and private transaction capture. No production writer, installer, rollback implementation, connector or task execution API was changed.

Existing production writers have separate serialization boundaries: task store and event log use separate file locks and atomic replacement; results have their own manifest lock; receipts serialize signed append independently; coordinator claims/history have independent daemon ownership; access and budgets use their documented access-before-budget lock order; enrollment owns its persisted mutation queue; OAuth (`src/gateway/auth.ts`) owns its in-memory state and persistence queue; installer journals and immutable release staging are another writer. Activity, audit, trace and checkpoint writers also participate. None currently supplies a common committed generation or global snapshot boundary. Atomic replacement and two identical reads cannot prove a transactional snapshot.

The source contract therefore requires explicit checkpoints from eight writer groups: tasks/results/events; receipts; coordinator; policy/grants/budgets/plans; enrollment/revocation; OAuth; runtime/installer; activity/audit/trace/checkpoints. Synthetic admission closes before capture, all acknowledgements bind one generation, active or failed writers invalidate the boundary, and any later content/inode/change-time/directory-membership change invalidates it. A failed partial writer poisons that cohort. A boundary from another cohort, generation, workspace or JSON serialization cannot become a capability. Hashes are checked against the independently held source manifest, never an expectation taken from the backup itself.

**Production coordination adapter is unavailable.** No live writer was paused. A future adapter must obtain acknowledgements from every actual writer, close all admissions until verification finishes, expose death/partial-commit refusal, and preserve node-local authority. It needs a separate source implementation and review before a live maintenance request is executable. The synthetic cohort alone does not prove an installed transactional snapshot.

## Coverage, links and registry

The versioned registry is `familyRegistry()` in `scripts/lib/recovery-coverage.ts`. It records owning writer, exact family directory, required dependencies, privacy, absence policy, retention and schema handling. All present contents are integrity-bound; derived/rebuildable does not mean disposable.

| Class | Families / policy |
| --- | --- |
| AUTHORITATIVE | Tasks, events, results, signed receipts/keys, enrollment/access/grants/budgets, node-auth, OAuth, secrets, plans, coordinator, runtime/transactions, audit, checkpoints, installer status, activity, five service definitions, worker config |
| DERIVED | Logs, OAuth canary status, OAuth health; included as evidence, never authority |
| REBUILDABLE | Compatibility home; present contents preserved, rebuilding has no authorization here |
| HISTORICAL_PRESERVATION | Recovery evidence, installer rollback preservation, exact `macos-hardening-rollback-` six-character suffix directories containing five historical plists |
| OPTIONAL | Independent revocations, canary configuration and traces; absence is normal, unreadable present state blocks |
| UNMAPPED | Any other owner-state top-level family is reported UNKNOWN and blocks certification |

Two historical service-preservation directories were observed with five plists each and are now mapped. They are preserved despite references to a missing older runtime. Current read-only inventory found 84 links: 82 dependency links and two historical compatibility links. Default supported links are relative links inside one immutable release's own `node_modules` boundary. Explicit internal-alias rules are tested only in fixtures; no live approval was invented. Links retain exact text, mode/ownership, volume association, role and non-dereference semantics. Required targets must also appear independently in the manifest. Absolute links, escapes at any hop, cycles, dangling targets, unknown roots, changed link/hop identity and unapproved volumes refuse. Directory links do not hide separately inventoried contents.

Immutable release dependency files and copied checkpoint `untracked` payloads are opaque bytes, not invented owner JSON schemas. Authority JSON remains interpreted by canonical readers. Compatibility-home bytes remain covered; its unsupported/dangling historical links still block. Unknown future directories, required omissions and stale manifests fail. Public reports exclude private paths, file/credential hashes and task identities; private manifests must never enter Git.

## Synthetic backup and restore

Capture requires a minted temporary workspace, exact frozen source roots, approved synthetic destination identity, private permissions, known volume, measured budget and capacity reserve. Each UUID reserves its own private transaction directory using exclusive creation; no replacing rename or overwrite path exists. This directory is staging until certification. Files are synced, all nested directories and link parents are synced bottom-up, and the destination parent is synced before a receipt becomes certified. Interrupted transactions remain UNCERTAIN; lost responses can be inspected against the original expected manifest without repeating the copy. An unknown process-local ledger after process loss remains UNKNOWN with no retry authority. A production durable independent expectation/reconciliation adapter is not supplied or implied.

Restore verifies the captured artifact, then interprets task lineage and canonical results, event/task state/attempt/actor/node agreement, receipt chains and signing continuity, policy and expired grants, budget policy/usage, consumed versus expired plans, enrollment/revocations, worker roots, coordinator history/claims, retained synthetic runtime digest and service entrypoint compatibility. Recomputed manifests cannot hide malformed application state. Actor/node collision and ambiguous-task replay refusal are tested. No restored service is launched or registered.

Genuine reader source from retained C13 revision `87a99494ebb3471d3ecc3a79acd630ec18858a92` is compiled in the synthetic workspace, using the current installed development dependencies. Schema-1 task/result readers retain identities, lineage, result metadata and values; both old and current retry rules refuse ambiguous effects. The old source lacks `decideExistingTask` and `readValueForTask`; it cannot claim the newer actor-bound duplicate/result attachment gate. Current readers exercise that gate and refuse different actors/nodes. This is a documented compatibility boundary, not an old-runtime authority proof or an historical dependency reproduction.

Synthetic receipts say `SYNTHETIC_BACKUP_CERTIFIED`, `scope: synthetic`, `installationAuthority: false`. Serialized copies are not trusted capabilities. Actual owner backup restorability remains UNVERIFIED.

## Seventeen unresolved owner records

Fresh read-only preflight still reports 15 PREPARING records with persisted AMBIGUOUS_EFFECT history and two RUNNING pure-read records with INSUFFICIENT_EVIDENCE. All 17 have MISSING task-bound result proof, UNKNOWN process state, UNPROVEN external effect and UNPROVEN_NO_REPLAY recovery eligibility. Four have no recent operation/node receipt candidate; thirteen have conflicting unbound candidates. Candidate signatures and matching operation/node do not bind a receipt to a particular task or prove completion. Missing process association is not proof of termination.

The report separately presents observed task/process state, result/receipt/external-effect proof, safe recovery eligibility and owner decision requirement. Private task identity, lineage and original actor are available only to the operator through `tasks --private`; do not redirect that output into Git. No task was cancelled, completed, replayed or persisted into a new classification. Task resolution requires original authority and specific task-bound evidence; age and transport loss cannot authorize it.

## Fresh storage measurements and options

Read-only metadata inventory measured owner state at 2,197,700,526 logical bytes and 2,484,297,728 allocated bytes across 112,976 entries, with no lstat errors; worker state added 212 logical / 4,096 allocated bytes. This moving inventory is not a consistent backup or a certified required-byte total. A partial coverage scan stopped on unsupported families/links and concurrent writes. Do not use its smaller observed subtotal as the full payload budget.

Fresh available internal capacity was 10,342,682,624 bytes (about 9.63 GiB), with a mandatory 2 GiB reserve. Capacity must be remeasured at admission. `recoveryStoragePlan()` rounds each included object to 4 KiB, adds directory allocation, private manifest plus 64 KiB metadata allowance, one isolated restore, 128 MiB temporary allowance, candidate runtime, dependency staging and growth reserve. Existing retained-release occupancy is reported but is not charged a second time against free bytes. Candidate/dependency bytes and a complete stable live inventory are still required; **no certified live required-free total or viable approved destination exists**.

| Option | Capacity and reserve | Privacy, durability and accessibility | Approval / failure boundary |
| --- | --- | --- | --- |
| Existing internal MacBook volume | About 9.63 GiB free at measurement; 2 GiB minimum reserve; complete budget unknown | Owner-only mode/UID; independently verified encryption and durable directory sync; local restore accessibility | Exact new destination/root/volume/inode and writer window unapproved; low space or same-volume device loss blocks or defeats redundancy |
| Existing external volume | Capacity/identity UNVERIFIED; 2 GiB reserve plus measured payload/restore/candidate budget required | Must independently establish device/mount identity, encryption, ownership, reliable durability and restore access; disconnect is a failure | No external destination approved or selected; mounting alone proves neither reliability nor permission |
| Another owner-controlled location | Capacity and identity UNVERIFIED; complete reserve/budget required | Explicit privacy, cloud policy, encryption, durability and offline restore access required | No location approved; no Google Drive, another host or default disk selection authorized |

Admission refuses changed/wrong/unknown volume or inode, symlink destination/ancestors, source or Git overlap, unapproved cloud sync, unsafe permission/ownership, unknown budget, insufficient capacity or reserve and unproven encryption/durability. No destination was chosen or write-probed.

## Prospective retained-C13 rollback baseline

The proposed previous runtime is exactly `0.3.2-87a99494ebb3-2f44ae46b11b`, tree SHA-256 `fcb78a6b99db10aac565a1b2b4af90faf142ef5bd5162523a662febeafd36b12`, historical source `87a99494ebb3471d3ecc3a79acd630ec18858a92`, historical install transaction `9bf5079f-397e-4cd8-af35-99f1550d3d68`. Fresh preflight rehashed the retained tree and verified all five service definitions/loaded release routes, four persistent processes and idle successful OAuth canary. Maintenance helper is idle. No service was interrupted.

This is journal-bound provenance. It is not a full-SHA immutable-release manifest. A fresh prospective transaction needs separately approved historical provenance, protected expected dependency/configuration/policy/owner-manifest digests, exact source/journal binding, complete stable coverage, metadata preservation and reserve, plus all five service routes and idle installer/rollback/helper proof. Supplied booleans or arbitrary JSON do not create live evidence. Changed tree, wrong journal/source, mixed services/configuration/policy, incomplete coverage, missing dependency identity and active/uncertain maintenance refuse. The missing older release is not recreated and old capsules are not rewritten.

Source rollback refusal tests and synthetic restore tests do not certify an actual rollback. Actual rollback proof requires separately authorized execution of the existing installer/rollback ownership path followed by service/process/release/health readback, fresh same-ID durable task/result proof and protected-state comparison. The existing runbook remains authoritative; this packet does not provide a permission-bypassing installer command.

## Preflight and next bounded packet

The existing 20 checks are retained and ten named typed recovery gates are added: symlink policy, known families, consistent snapshot, independent expected manifest, destination, durability, application restore, task disposition, retained provenance and exact candidate identity. Missing fields, fixture evidence, arbitrary approval JSON and stale CI cannot authorize installation. All ten live boundary gates remain false because a trusted production evidence adapter is unavailable. CLI states distinguish source validation, PRIVATE_BACKUP_UNVERIFIED, ROLLBACK_BASELINE_UNVERIFIED and INSTALLATION_BLOCKED. The type contract names BACKUP_CERTIFIED and INSTALLATION_PREREQUISITES_PASS, but neither is currently mintable by this CLI.

Safe read-only commands, run from the verified worktree:

```sh
npm run recovery:c14 -- preflight
npm run recovery:c14 -- coverage
npm run recovery:c14 -- tasks
npm run recovery:c14 -- tasks --private
```

Preflight exit 2 means BLOCKED. The private command is for the operator's terminal only. There is no live capture, pause, install or approval flag. `liveCapture()` refuses unconditionally.

Next source requirement: implement and independently verify the production writer-checkpoint and durable independent-evidence adapter; resolve exact historical link roles without omitting their preservation contents; bind the candidate and complete measured budget. The smallest subsequent live authority would be one bounded window on MacBook-Air.local / macbook-air.local for all eight writer groups, one owner-selected exact private destination and volume identity, and one uniquely identified capture plus isolated restore under independently protected expectations. It would allow no task replay, owner-policy change, install, restart, rollback, capsule overwrite or connector administration. Those remain separate approvals. No live action is executable solely from this packet.

## Program and validation receipt

C13 NOT PASS. E7 BLOCKED — HOST CAPABILITY; actual owning-host connector interruption proof remains absent. C14 source validation/publication receipt follows below. C14 program PARTIAL / NOT COMPLETE. C15 BLOCKED. Synthetic proof does not establish installed, connector, ecosystem or human acceptance.

Independent source review found nested-directory durability, replacing-rename publication, task/event consistency and expired-plan claim defects. They were repaired with regressions. Review was read-only and is distinct from executed tests. Validation and exact publication identities are appended after measured completion.

## Adversarial second pass and validation — 2026-10-10

Continued in the same verified worktree from clean local/remote `cd167b81ad65c21900e7f2d06e12c25cbf9b84c7`; the uncommitted boundary implementation above was reviewed, then frozen as the candidate. Each confirmed defect first received a failing regression, then a root-cause repair:

1. **Closed-world services and worker roots.** Extra or renamed `com.stinkyweasel.dex-reach.*` LaunchAgents and any unexpected worker-root entry were silently omitted. They are now UNKNOWN families and block certification. Only a genuine socket `worker.sock` (live IPC endpoint, never copied) is exempt; non-DEX LaunchAgents remain outside owner state.
2. **Masked hosted checks.** The live preflight collapsed `statusCheckRollup` with last-entry-wins, so a failed or unfinished run could be hidden by a later same-named success. `aggregateCheckRuns()` now marks duplicates AMBIGUOUS and unfinished runs INCOMPLETE.
3. **Ancestor directory links.** A link to itself or an ancestor directory (`node_modules/x -> .`) was accepted. It is now `LINK_CYCLE`. All 78 live release links were inspected read-only: all are `node_modules/.bin` file links.
4. **Lexical `..` collapse (independent review).** Link targets were collapsed lexically before hops were inspected, so `a/../../b` where `a` is itself a link was accepted while the kernel resolved outside the dependency boundary; `missing/../b` was accepted while dangling. Resolution is now physical, component by component; accepted links are tested to equal the kernel's `realpath`.
5. **Silent optional-family truncation (independent review).** ENOENT anywhere in an optional family's walk became EXCLUDED_BY_POLICY with no problem, truncating the inventory. Only an absent family root is an exclusion now; vanishing mid-walk is UNREADABLE and inconsistent.
6. **Open `tasks/` directory (independent review).** Siblings of `tasks/store.json` and `tasks/events.jsonl` were neither inventoried nor flagged. File-level family parents are closed-world with membership tracking: locks/temporaries are transient-write problems, other names are UNKNOWN.
7. **Late source write and unread private manifest (independent review).** Capture now re-validates the frozen generation after the final directory sync, immediately before certification; reconciliation verifies `manifest.private.json` against the held manifest.

Task reporting now also presents `EXECUTION_EVIDENCE` (absence reported as `NONE_OBSERVED_NOT_TERMINATION_PROOF`) and `UNRESOLVED_UNCERTAINTY` (receipt task binding and external effect always remain unresolved) beside the existing state/result/receipt/effect/eligibility sections.

Fresh read-only live inspection after the repairs: 17 nonterminal records unchanged (15 PREPARING AMBIGUOUS_EFFECT; 2 RUNNING INSUFFICIENT_EVIDENCE; 11+2 with conflicting unbound receipt candidates, 4 with none), `replayAuthorized=false`. Coverage found zero UNKNOWN families and still refused completeness for live coordinator writes/locks, changes during inspection and the historical compatibility links. Retained tree digest and five-service identity verified; free space 13,054,287,872 bytes at measurement. Preflight BLOCKED. No live backup, manifest, capsule, task transition, restart or install occurred.

Validation of the cohesive candidate: focused recovery suites (boundary, foundation, rollback) 200/200 PASS with no synthetic workspace left in the OS temporary directory; `npm run verify` exit 0 — typecheck PASS, 42/42 invariants PASS, 583/583 tests PASS (0 fail/cancelled/skipped), build PASS, audit at unchanged high threshold PASS (six moderate advisories retained), 26-tool backend probe PASS; `git diff --check` PASS. The independent review was read-only source review, not execution or certification. Commit identity and exact-head hosted checks are recorded from Git/PR owning state after publication, not here.

Remaining limits are unchanged: no production writer-checkpoint adapter, no independent durable digest store, cross-volume backup verification fails closed on volume identity (an external destination needs an explicit adapter), owner backup restorability UNVERIFIED, historical compatibility links still block, and all ten live boundary gates remain false.
