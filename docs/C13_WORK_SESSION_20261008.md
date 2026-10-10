# C13 work session — 2026-10-08

## Verdict

**C13 BLOCKED — HOST CAPABILITY AND RUNTIME AUTHORITY; NOT PASS.** E3 is PASS. E4 passed at the time of its original readback; a current reread finds its result reference expired. E7 is BLOCKED — HOST CAPABILITY. C14 remains preparation-only and C15 has not started.

## Completed

- Published reviewed fixture-freshness corrections to the existing Stinky Weasel Control Site as version 2. Owner-only access remains one owner, zero visitors, zero groups. Live Brave verification shows the stale static snapshot is labeled clearly and directs owners to the local Control Room. Desktop and 390px viewport were inspected; no physical-device acceptance is claimed.
- Kept the static Site explicit: it has no live refresh, current task state, service health, or control authority.
- Preserved the installed fingerprint transport repair and its E4 real-host proof. The same durable task completed and its same-ID result was read; original failures and ambiguous-effect records remain preserved.
- Repaired routed coordinator acquisition so caller PID is recorded separately from an optional workload PID. The regression tests cover caller identity and queue persistence. This queue-ticket repair is source-only and not installed.
- Inspected the connected DEX//REACH Refresh settings. They expose Uninstall, Refresh tools, rename/reconnect account actions, and app metadata. No connector disable control is exposed there. No connector setting, credential, or registration was changed.

## Source and validation

Target: `/Users/andrew/dex-reach-c13-worker-repair`, branch `c13-worker-repair`, based on `175d58b8cce59a60a2516fd65e4b093f1a370b55`.

`npm run verify` passed: typecheck, 42 invariants, 333/333 tests, build, production dependency audit at the configured high-severity threshold, and backend probe (26 local tools). npm reported six moderate dependency advisories; no dependency change was made. `git diff --check` passed. Focused regression run passed before the full suite.

The fingerprint repair remains installed in immutable release `0.3.2-175d58b8cce5-2f44ae46b11b-dirty-1791501412637`. Current CLI status reports the node running, gateway connected, AI access enabled, and `full-local` profile. The queue-ticket repair has not been installed or runtime-proven; no service restart or installation was performed.

## Remaining gate

E7 requires the owner to make a temporary disabled state available for the existing connector, without uninstalling/recreating it or changing credentials. Then, while one genuine durable task is RUNNING, disable and re-enable the connector and read that same task's result by ID. Until that occurs, E7 is PARTIAL and C13 is NOT PASS.


## Autonomous takeover revalidation

The verified execution node is `macbook-air.local` on `MacBook-Air.local` (Darwin arm64, user `andrew`). Fresh node discovery reports online, `full-local`, AI access on, four DEX services, zero active leases, and zero queued work. The installed CLI reports the node running and gateway connected. No operation was routed to another node.

The installed release remains `0.3.2-175d58b8cce5-2f44ae46b11b-dirty-1791501412637`. Inspection of its compiled coordinator confirms it still derives `pidIsWorkload` from `request.pid !== undefined` and lacks `bindCoordinatorCaller`; the pushed branch repair is not installed. `npm run install:macos` stages a new immutable release and replaces the four service LaunchAgent definitions through its one-shot reload helper. No supported rollback workflow was found: the owner task-control documentation says restart/rollback controls are preview-only, and no last-known-good install rollback procedure is established. This task did not authorize service installation/restart, so neither was attempted.

The prior E4 durable fingerprint task remains `COMPLETED`, attempt 1, on the same exact task ID. Its result reference is now expired: a current same-ID result read returned `result handle not found or expired`. The historical E4 PASS is preserved; no new durable task was started.

The Stinky Weasel Control Space is present with its human-facing root plus Projects, Runbooks, Command Roster, System Status, and Prompt Forge pages. Current sharing readback has no direct shares or inherited access. The existing Site is active; version 2 deployment reports `succeeded`, with custom access and one allowed account. Its static task snapshot is explicitly stale and does not establish current Site/local-task parity required by the broader master-plan validation.

Current connector tools expose no supported disable action. The app detail previously showed Uninstall, Refresh tools, and account rename/reconnect; none provides the required disable interval. The workspace Admin route returned a rate-limit page. No connector changes were made, and no task was started without a supported recovery path. E7 is therefore **BLOCKED — HOST CAPABILITY**.

A new regression in `tests/coordinator-daemon.test.ts` drives a short-lived caller through the real daemon IPC path, queues behind a conflicting repository lease, waits for that process to exit, and asserts that the persisted ticket carries the caller PID with `pidIsWorkload: false`. Focused tests passed 43/43. Full `npm run verify` passed 333/333 tests, 42 invariants, build, configured production audit threshold, and backend probe (26 tools). Six moderate npm advisories remain.

Commit `736902c3accb8aa95970ddfedf1a95f02ac26ff9` is pushed to `c13-worker-repair`. Draft PR [#15](https://github.com/westkitty/DEX-REACH/pull/15) is open to trigger and expose the repository's pull-request checks. It has not been merged. Hosted validate, reproducible-build, runtime-proof, analysis, and CodeQL checks passed on source/test commit `736902c3accb8aa95970ddfedf1a95f02ac26ff9`. The CI runtime-proof is the runner’s loopback pair; it does not install or prove the MacBook runtime. PR #15 remains the owning source for any later documentation-only head and CI status.

## Runtime deployment readiness revalidation — 2026-10-09

**Source rollback preparation PASS; live deployment remains NOT AUTHORIZED and NOT PROVEN. C13 remains NOT PASS.** The exact target is the MacBook Air node `macbook-air.local` / `MacBook-Air.local`, arm64, on branch `c13-worker-repair` in `/Users/andrew/dex-reach-c13-worker-repair`. No operation targeted Big Mac.

The installer now captures a private, integrity-checked last-known-good recovery capsule for exactly five DEX LaunchAgent property lists plus the worker configuration before it mutates active service files. It records the prior and candidate immutable release identifiers and full tree hashes, uses restrictive file permissions, serializes install and rollback with one runtime lock, and refuses mismatched, modified, mixed, or ambiguous state before restoration. `npm run rollback:macos -- --candidate-release-id <id>` is the source recovery entry point. Recovery restores the exact previous files and then reloads the persistent services and runs the existing OAuth canary; its behavior has regression coverage but has not been executed on the MacBook.

At inspection, all four persistent services were running under distinct PIDs; the canary was idle and enabled. All five active LaunchAgent definitions still referenced immutable release `0.3.2-175d58b8cce5-2f44ae46b11b-dirty-1791501412637`. The release contained 22,260 files and measured SHA-256 `b60194780c0cb0e05e65fc5496bcb76b458094381bff55d29f9de4e85fc3bb4b`. No rollback capsule existed before this source change. The installer and rollback procedure were not run; there was no service restart, release switch, credential/policy change, or cleanup. After full source verification, launchd still showed the same running service set and the plists remained unchanged.

Local validation passed `npm run verify` (347/347 tests, 42 invariants, build, configured production audit threshold, and 26-tool backend probe), focused rollback tests (13/13), typecheck, and `git diff --check`. Six moderate dependency advisories remain; no dependency update was made. The first hosted CodeQL run flagged chained XML entity decoding in commit `c536440`; commit `56b95b3` changed both plist decoders to one-pass entity replacement. A final reporting correction made rollback status preserve the verified live node count instead of recording a constant. Hosted validate, runtime-proof, reproducible-build, analyze, and CodeQL all passed on exact source commit `9d45d29bd9df8ee96f96d5ca14d267ce8d5c29ca`. These checks validate source and simulated recovery states; they do not establish that an installed release can be restored successfully on the live host.

**Next gate:** owner authorization for one exact MacBook maintenance window covering installation and recovery acceptance. Until then, keep the currently installed immutable release and all LaunchAgents untouched. E7 remains independently BLOCKED — HOST CAPABILITY; C14 remains preparation-only and C15 has not started.


## Installation handoff repair — 2026-10-09

SOURCE IMPLEMENTED. The canonical operator procedure is [C13 installation runbook](C13_INSTALLATION_RUNBOOK.md), backed by `scripts/c13-maintenance.ts` and focused acceptance/cleanup helpers. Successful acceptance retains the candidate; rollback is a separate explicitly authorized command. Installer status is bound to a UUID transaction, candidate runtime root and fresh timestamp. No manual task-ID placeholder remains: the installed CLI retrieves one new node-owned fingerprint task and verifies a complete same-ID connector result supplied via clipboard. Actor hashes, task/result metadata and content are checked; historical E4 expiry cannot satisfy new acceptance.

Failure classification distinguishes SAFE TO RETRY, SAFE TO ROLLBACK, NEEDS RECONCILIATION and REQUIRES OWNER INPUT. Known partial activation is recoverable only with a valid exact-prior capsule and inactive helper/canary; unknown revisions, duplicate services, live/scheduled helpers and failed rollback remain visible. Queue acceptance imports the installed client and requires the daemon for each call. Canonical temporary-root ownership, caller/workload PID semantics, persisted ticket behavior, scoped cleanup and lost-response reconciliation are preserved. Pending cleanup is journaled before admission and blocks later acceptance/rollback until absence is proven. SIGINT/SIGTERM and bounded already-exited-child handling have regressions; SIGKILL/power-loss requires scoped readback rather than replay.

SOURCE TESTED: final focused acceptance/rollback/coordinator suite passed 42/42; typecheck and whitespace checks passed. Final `npm run verify` exited 0: 369/369 tests, 42 invariants, TypeScript, build, configured high-severity production audit threshold, and 26-tool backend probe all passed. Six moderate advisories remain. All runbook shell blocks passed `zsh -n`; `git diff --check` passed. Independent review found and prompted fixes for unresolved-cleanup classification, macOS temporary-root canonicalization, all-five-service recovery identity, daemon fallback and signal/exit event timing. No dependency or connector change was made.

CI VERIFIED: owning GitHub readback reports five successful required checks on unchanged draft PR #15 HEAD `574a3716604750b8551cb1f4174472918114b4e4`; none covers these uncommitted edits. INSTALLATION READY: procedure implemented; clean committed/published source plus exact-head hosted checks and live read-only preflight remain prerequisites. The preflight was actually invoked and correctly refused the uncommitted checkout before runtime mutation. INSTALLED/RUNTIME VERIFIED/ROLLED BACK: not performed for this repair. The recorded prior runtime tree and four running service identities were read locally; no install, restart, rollback, policy widening or source publication was executed.

HOST BLOCKED: E7 remains BLOCKED — HOST CAPABILITY. C13 remains NOT PASS; C14 is preparation-only; C15 has not begun. The full owner-run commands and failure recovery table are in the runbook. Next justified action: owner review and separate authorization for source commit/push, followed by exact-revision hosted CI before a separately authorized maintenance window.

Final source-scope receipt: repair PASS. After final verification, all five LaunchAgent hashes and the previous runtime tree matched the local pre-verification readback; coordinator/worker/gateway/node PIDs remained 1082/1090/1077/1083, and canary was idle. This proves the measured retained-runtime state, not live installation or recovery acceptance. No commit, push, PR update, merge, installation, restart or rollback was performed.
