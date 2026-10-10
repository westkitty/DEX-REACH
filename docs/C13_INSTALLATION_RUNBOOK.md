# C13 MacBook installation and conditional recovery

Scope: the MacBook Air `MacBook-Air.local`, arm64, model `MacBookAir10,1`, account `andrew`, exact node `macbook-air.local`; checkout `/Users/andrew/dex-reach-c13-worker-repair`, branch `c13-worker-repair`, remote `westkitty/DEX-REACH`. This is a single upgrade from the recorded previous release, not a general deployment framework. The installer/rollback scripts remain the owners of runtime staging/restoration; this helper stages acceptance and records recovery eligibility. Historical failure evidence stays intact.

**Do not execute live stages until the owner explicitly authorizes a maintenance window.** Source commit/push and hosted checks are separate prerequisites requiring separate authorization. The repair is deliberately left uncommitted by this task. Do not install a dirty candidate or the former `574a371` candidate: it does not contain this handoff repair. After authorized source publication, the helper resolves the new candidate from the clean exact HEAD and lockfile, requires remote equality, and records both identities in a private journal before installation. It refuses a changed expected candidate inside the installer.

Previous release: `0.3.2-175d58b8cce5-2f44ae46b11b-dirty-1791501412637`. Its required full-tree SHA-256 is `b60194780c0cb0e05e65fc5496bcb76b458094381bff55d29f9de4e85fc3bb4b`. A changed baseline requires owner investigation; do not edit hashes to force acceptance.

## A. Read-only preflight

Run from a separate owner Terminal, outside the DEX transport being replaced. Keep that Terminal open throughout the window. Arrange an idle machine with no other installer or real coordinator reservations. Do not kill other work to obtain it.

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && node --import tsx scripts/c13-maintenance.ts preflight
```

This performs no installation, journal write, task creation, coordinator pruning, service restart, secret/policy change or release switch. It verifies host, account, model, checkout, branch, exact clean HEAD against the owning remote, enrollment ID, existing private state, previous release tree, enabled LaunchAgents, launchd working directories, process ownership, distinct service PIDs, duplicate runtime processes, idle successful canary, absent or authoritatively stopped helpers (including a failed helper with no PID, active count zero, and no running/waiting/scheduled state) and empty persisted lease/queue directories. Missing state or an unavailable readback fails closed. It never reconciles a mismatch automatically.

Before publication, a clean-tree refusal is expected. `INSTALLATION READY` means this preflight passed; it does not establish hosted CI or runtime acceptance. Verify the five required hosted jobs on the exact subsequently published HEAD separately.

## B. Explicit live installation

Only under the separately authorized window:

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && node --import tsx scripts/c13-maintenance.ts install --authorize-live
```

The helper reruns preflight, records a random transaction ID, source HEAD, candidate ID, prior active file hashes and protected enrollment/access/budget-policy/secret-file digest at `~/.dex-reach/runtime/c13-maintenance.json`, and calls the existing installer once. No secret contents are printed or copied into this journal. The installer compiles directly into private runtime staging, captures its integrity-checked rollback capsule, writes only generated worker/service configuration, and delegates activation to the one-shot LaunchAgent. Transaction and candidate root now follow every helper status update. Installer and rollback share the existing runtime lock; acceptance stages use a separate journal lock.

The command returning does **not** prove activation. A three-minute installer timeout is uncertain, not permission to replay. An unknown-operation marker is durable before invocation; interrupted/timeout effects remain blocked until a fresh terminal transaction receipt or explicit reconciliation. Never run the installer a second time just because a client disconnected. The helper's activation/canary may take several minutes. Do not run rollback while it can still execute.

## C. Fresh durable-task verification

After activation has had time to complete, run the following bounded observation. It can be repeated as a readback; it does not repeat installation. It writes only its own journal and opens a task freshness window once activation, transaction-bound completion, exact service identity and both release trees are proven.

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && node --import tsx scripts/c13-maintenance.ts observe
```

If observation fails, follow section F. While an installer helper is live, waiting, scheduled, or its state is uncertain, wait and use the report command; do not infer failure from elapsed time.

The installed owner CLI has task inspection/result commands but **no supported task-start command**. In the existing ChatGPT connector, request this separately staged action:

> Discover and select exact node `macbook-air.local`. Start exactly one fresh `reach_task` with `action: start`, `mode: durable`, `operation: dex.fingerprint`, and `arguments: {"cwd":"/Users/andrew/dex-reach-c13-worker-repair"}`. Record the returned durable `rtsk_` ID. Use that same returned ID and exact node for `reach_task(get)`, then `reach_task(result)` after completion. Return the complete JSON result response, including its `task` and `result` objects. Do not reuse any historical task/result handle, retry an ambiguous start, or modify the connector.

A connector-start timeout requires node task inspection first; it does not authorize another start. Read-only get/result polling is safe. If multiple fresh matching tasks exist, the helper refuses to guess. Resolve the selection with the owner; do not delete tasks or alter timestamps. Actor identities are node-issued hashes, not literal client names: the returned connector readback must match the recorded actor, task, node, persisted reference, hash and result.

Copy the complete JSON `reach_task(result)` response (or its complete MCP text-content envelope) to the macOS clipboard, then run:

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && /usr/bin/pbpaste | node --import tsx scripts/c13-maintenance.ts record-task
```

No command editing or task-ID substitution is needed. The helper retrieves exactly one fresh durable ID programmatically using the **installed** CLI, reads its persisted result through that CLI, validates the copied same-ID connector result against node-owned metadata/content, and records the ID and a digest of the supplied readback. Missing JSON, missing ID, old creation time, wrong actor/node, attempt other than one, incomplete/non-read-only task, mismatch or expired result cannot pass. This validates supplied evidence; clipboard provenance remains an operator responsibility. It does not independently observe the ChatGPT UI.

## D. Installed queue regression and E. Decision

Run promptly within the result store's 30-minute validity window and only under authorization for acceptance/test reservations:

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && node --import tsx scripts/c13-maintenance.ts accept --authorize-live
```

Acceptance rechecks the runtime and fresh same-ID persisted result, imports the **active immutable release's coordinator client**, requires the real local daemon on every client call (no direct fallback), and refuses if real work is present. It journals the canonical temporary root before admission and uses a unique temporary repository and a light conflicting mutating lease. A bounded child caller must queue with its own PID and `pidIsWorkload:false`. The ticket must retain that identity after caller exit until the existing stale interval; immediate eviction would violate the current coordinator contract. Existing deterministic coordinator tests separately retain explicit workload-PID semantics.

Cleanup runs after success, supported exceptions/timeouts, and SIGINT/SIGTERM: stop only the test child, inspect/cancel tickets for the unique test root, release only leases for that root, prove none remain, remove only the empty temporary test directory. A lost admission response is reconciled by that unique root, never replayed. Other reservations are untouched. A cleanup refusal records a sticky pending canonical root and blocks acceptance and rollback until scoped reconciliation proves all its reservations absent. Exit observation handles an already-exited child and bounds missing exit evidence. A cleanup refusal is a failed acceptance with visible error, not recovered success. SIGKILL/power loss cannot run JavaScript cleanup; the pre-admission journal preserves the root: see reconciliation below; expired claims follow existing PID-plus-staleness rules.

Acceptance repeats runtime/integrity checks after queue cleanup. **`RETAIN CANDIDATE` leaves the candidate installed and running. There is no rollback on success.** Local installed acceptance does not establish E7 or overall C13 PASS. Do not run the rollback command as a routine final step.

## F. Failure recovery — conditional rollback

Use fresh owning-system readback first:

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && node --import tsx scripts/c13-maintenance.ts report
```

The journal preserves the error and the fresh observation reports recovery eligibility separately from historical decision state.

| Classification | Operator action |
| --- | --- |
| SAFE TO RETRY | Only when helper is proven inactive, previous services/tree and exact pre-install definitions/configuration are intact, and no rollback capsule was created. Correct the reported non-consequential cause, rerun preflight, then rerun the authorized install command. Prior journal history is retained. A remaining capsule blocks automatic replay. |
| SAFE TO ROLLBACK | Helper is proven inactive, previous tree/capsule valid, and every active file belongs to the recorded old/candidate transaction. Partial activation, missing services, candidate corruption, health/task/queue failure can take this path. Execute the command below only under explicit rollback authorization. |
| NEEDS RECONCILIATION | Live/scheduled helper, timeout without authoritative outcome, duplicate process, unexpected loaded revision, unknown active files, failed rollback, lost cleanup outcome, or unavailable probes. No blind retry or rollback. Preserve the journal, status files, capsule and previous tree; inspect launchd, process ownership, active-file hashes and scoped reservations with the owner. |
| REQUIRES OWNER INPUT | Missing/corrupt capsule after changed activation, damaged previous tree, changed protected state, or failed host/revision preconditions. Stop consequential actions; retain evidence and healthy services. Do not rewrite metadata, relax policies or substitute a guessed revision. |

Authorized conditional rollback:

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && node --import tsx scripts/c13-maintenance.ts rollback --authorize-live
```

This refuses unless a fresh observation yields SAFE TO ROLLBACK. The existing rollback validates all previous bytes and active old/candidate file membership before writes, restores exact prior definitions/configuration, reloads services and runs the canary. The maintenance helper then checks the exact prior revision, service ownership, tree digest and fresh rollback receipt. Failed rollback remains visible with `NEEDS RECONCILIATION`; it never reports recovered. An owner may authorize repeating restoration only after fresh reconciliation proves eligibility; the helper never automatically replays it.

After a hard interruption or timeout without a terminal transaction receipt, use this reconciliation stage only when readback proves no installer/reloader/rollback process or mutating launchctl command remains, the helper and canary are inactive, and every current file belongs to the old/candidate transaction (or matches the untouched prior baseline):

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && node --import tsx scripts/c13-maintenance.ts reconcile-install
```

This clears only the journal uncertainty marker after those probes; it performs no install/reload or rollback. Unknown files, damaged prior state or active effects keep it blocked. Rerun report afterward and follow its eligibility, rather than replaying the timed-out operation.

After normal stale recovery or separately authorized owner-scoped cleanup, prove the recorded test root has no lease/ticket files and clear only the journal's pending marker:

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && node --import tsx scripts/c13-maintenance.ts reconcile-queue
```

This does not delete reservations, reset the task store or replay any external operation. If reservations remain or the root is invalid, it refuses. A leftover empty temporary directory can remain as evidence after a hard interruption; this does not grant authority or reserve capacity.

For launchd/process inspection without mutation:

```sh
/bin/launchctl print gui/501/com.stinkyweasel.dex-reach.install-reloader-once
/bin/launchctl print gui/501/com.stinkyweasel.dex-reach.coordinator
/bin/launchctl print gui/501/com.stinkyweasel.dex-reach.worker
/bin/launchctl print gui/501/com.stinkyweasel.dex-reach.gateway
/bin/launchctl print gui/501/com.stinkyweasel.dex-reach.node
/bin/launchctl print gui/501/com.stinkyweasel.dex-reach.oauth-canary
/bin/ps -axo uid=,pid=,command=
```

Absent helper errors are evidence to reconcile, not a reason to recreate it. Never directly bootout/kickstart the DEX transport from that transport. Do not remove install locks or status files to conceal uncertainty. Following hard interruption, inspect only reservations carrying the unique `dex-c13-queue-` test root and its test PID/phase. Let normal stale recovery reclaim dead claims, or request owner-scoped cleanup; do not force-release unrelated work. The runbook intentionally offers no generic destructive cleanup command when ownership is uncertain.

## G. Final state report

```sh
cd /Users/andrew/dex-reach-c13-worker-repair && node --import tsx scripts/c13-maintenance.ts report
```

Record source HEAD/remote, transaction/candidate ID, task ID/readback digest, active service identities, previous/candidate integrity observations, journal decision/error and recovery eligibility. Report these states separately:

- SOURCE IMPLEMENTED / SOURCE TESTED: local implementation and actual focused/full verification results.
- CI VERIFIED: only hosted jobs read on the exact published revision; never inherited from the old head.
- INSTALLATION READY: successful clean-source read-only preflight and separate CI prerequisite.
- INSTALLED: candidate activation observed on the exact host.
- RUNTIME VERIFIED: staged installed task and queue acceptance succeeded, candidate retained.
- ROLLED BACK: fresh exact-prior restoration independently read back.
- HOST BLOCKED: E7 remains BLOCKED — HOST CAPABILITY; no supported connector disable/re-enable path. No credential revocation, uninstall, gateway restart or simulated interruption substitutes for it.

C13 remains **NOT PASS**. C14 remains preparation-only. C15 does not begin. Source publication, installation, runtime verification and human acceptance are distinct. This procedure changes no credentials, enrollment, node-local authority, grants, budgets or historical stores; task/result readback and installation can append ordinary runtime receipts. The previous verified release and all rollback evidence remain retained.
