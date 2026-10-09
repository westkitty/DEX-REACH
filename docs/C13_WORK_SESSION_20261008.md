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
