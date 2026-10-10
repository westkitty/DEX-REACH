# C14 live coverage findings — root causes and source repairs

Scope: read-only live inspection on MacBook-Air.local plus source repairs on `c14-chaos-recovery`, starting from clean `75edeafd9d2f8255a4558693205d0d86f74628b2`. No live file, link, task, service, credential or connector was changed. C13 NOT PASS; E7 HOST CAPABILITY BLOCKED; C14 program PARTIAL; C15 BLOCKED.

The previous live coverage scan reported eighteen findings (8 coordinator transient/lock, 1 compatibility, 3 snapshot changed, 3 content changed after hash, 3 directory membership changed). They have four distinct causes.

## 1. Coordinator "transient write or lock" — orphaned atomic-write temps (8 of 8)

None of the eight is a lock or an active write. All are `<file>.<pid>.<uuid>.tmp` files from `atomicWriteFile`, dated 2026-09-21 to 2026-10-06 (two `capacity-health.json`, six `history/events.jsonl`). Every owning pid is dead. `atomicWriteFile` removes its temp in `finally`, so a temp only survives when its writer process died before the rename commit point. Such a file can never become committed. A coordinated checkpoint could not clear them either, so coverage would have blocked forever.

**Repair** (`scripts/lib/recovery-coverage.ts`): a temp in exactly the writer's naming pattern, owned by a pid that no longer exists, is classified `ORPHANED_ATOMIC_TEMP`. It is preserved and integrity-bound like any other file, never JSON-parsed, and compared on verification. A temp owned by a live pid (including a reused pid) still blocks. So do `.lock` files, unpatterned `.tmp` files and residue symlinks. Residue beside a file-level family (`tasks/store.json.<pid>.<uuid>.tmp`) is attached to that family and accepted by manifest validation only in that exact shape. Nothing is deleted. Regressions: `tests/c14-orphan-temp.test.ts` (5).

Live result after repair: 0 coordinator transient findings.

## 2. Compatibility `INVALID_OR_UNSUPPORTED` — compat-home links, plus a truncated walk (1 finding, 6 links)

`compat-home` is the desktop-commander adapter's isolated HOME (`src/node/adapters/desktop-commander.ts`). It holds pnpm 11 store data with six relative links:

- **four internal package links:** they resolve inside compat-home;
- **one dangling store project-registry link** (`package-manager-store/v11/projects/b6579c7d…`): its target, a pnpm temporary engine directory, was removed by pnpm;
- **one escaping store project-registry link** (`store/v11/projects/d92d8194…`): it points out of the state root to a user project directory.

Both registry links were created in the same pnpm session on 2026-10-04 15:08–15:09.

**Defect:** the first unapproved link threw out of the family walk. The whole family became `UNREADABLE`, and every entry after that link was silently missing from the inventory.

**Repair** (`scripts/lib/recovery-symlinks.ts`, `recovery-coverage.ts`):

- **Refused links:** an unapproved link is now reported precisely as `LINK_REFUSED:UNAPPROVED_LINK_<INTERNAL|DANGLING|ESCAPES_BOUNDARY|CYCLE>`. The walk continues, and the family status is `BLOCKED_BY_LINK_POLICY`.
- **New `preserved-opaque` role:**
  - It is usable only for the `compat-home` boundary and requires `requiredTarget:false`.
  - It records exact link text and identity and is never dereferenced.
  - Resolution is judged only inside the boundary, so an escaping target is never examined.
  - Absolute links and links that change during inspection still refuse.
  - The role cannot cover authoritative families, and other roles cannot use the opaque boundary.
- **Capture and restore** reproduce the links byte-identically; a dangling link stays dangling.
- **Classification:** compat-home is no longer labelled `REBUILDABLE`. It contains adapter credentials, keys and user applications, and is classified as sensitive preserved optional state.

Regressions: `tests/c14-compat-links.test.ts` (7).

**Not self-approved:** `defaultLinkPolicy()` stays empty. The live scan still reports the six links, now precisely. A read-only hypothetical scan with `COMPAT_HOME_PRESERVATION_RULE` showed compatibility `INCLUDED` with all six links preserved (4 INTERNAL, 1 DANGLING, 1 ESCAPES_BOUNDARY). Applying that rule to live certification is an owner decision.

A nested `compat-home/.dex-reach` tree (21 MB, 2026-09-19) is historical: a REACH process once resolved state from the adapter HOME. Coordination now resolves through `machineStateDir()`. The tree is preserved as opaque bytes.

## 3. Snapshot/content/membership changed — uncoordinated live writers (remaining)

These come from the installed services writing during an uncoordinated read (coordinator history and capacity, enrollment, task store/events). Only the writer-checkpoint fence can clear them. Participation is not enabled in any installed process, and enabling it needs an approved LaunchAgent environment change and restart. Repeated hashing is not a substitute and was not used as one.

## 4. Task journal flooding — admission wait status persisted every poll (contributes to 3; destroys history)

The live `tasks/events.jsonl` sits at its 2,000-entry cap, and its oldest retained event is from 2026-10-10 04:07Z, while the store holds 684 records. 549 retained events belong to the 19 unresolved records, and 517 of those are identical `WAITING_FOR_COORDINATOR: substantive slots exhausted …` updates. `acquireTaskAdmission` polls every 250 ms. On every poll the node called `taskStore.update`, which atomically rewrote the 1.3 MB store and the 0.9 MB journal and appended an event. The installed C13 runtime has no decisive-event reservation, so this evicted every other task's earlier history. C14 source reserves 1,500 decisive slots but still persisted every poll.

**Repair** (`src/node/task-admission.ts` `waitingStatusWriter`, used by `src/node/main.ts`): the status is persisted only when the coordinator's reason changes. Task state is still read on every poll, so a cancellation is never missed. Regression in `tests/c14-admission-contract.test.ts`: 120 polls with one reason produce exactly one event, and a cancellation is still observed on the next poll. The evicted live history cannot be recovered from the journal and was not reconstructed.

## Historical tasks (read-only reconciliation)

These are the 19 nonterminal records: 17 PREPARING `AMBIGUOUS_EFFECT` (`dex.process.run` ×13, `dc.call` ×2, `dex.plan` ×2) and 2 RUNNING `dex.file.read` `INSUFFICIENT_EVIDENCE`. All 19 `updatedAtUtc` values were rewritten within the same three seconds today (17:25:27–30Z), about 90 seconds after all installed services started at 17:23:54Z (low pids, consistent with a host restart). That timing fits the installed node's boot recovery. For most records, journal eviction has left a single retained event. None is provably resolved: results are missing, receipt candidates are unbound, process state is unknown, and absence of activity is not termination proof. `replayAuthorized=false`. No state was changed. Disposition remains an owner decision.
