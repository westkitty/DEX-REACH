# C13 work session — 2026-10-08

## Verdict

**C13 NOT PASS.** E3 and E4 are PASS; E7 is PARTIAL. C14 remains preparation-only and C15 has not started.

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
