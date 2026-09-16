# DEX//REACH Incident Prevention Notes

This file records confirmed failures whose root cause and repair were demonstrated during the 0.3.1 hardening sweep. It is not a speculative risk list.

## Incident A — a DEX-hosted installer killed the request installing DEX

### Confirmed symptom

Running `npm run install:macos` through the live DEX node could drop the request while the node disappeared. The initial installer performed `launchctl bootout` inline and then intended to write/bootstrap the replacement service. Once it booted out the node, the process carrying those later steps was gone.

### Root cause

The updater and the service being replaced shared the same launchd job/process lifetime. A request cannot reliably destroy its own transport and then continue as though it were independent.

An early repair using `launchctl submit` exposed a second confirmed failure: the submitted helper could respawn after successful exit and repeatedly cycle DEX.

### Fast recurrence signature

1. `npm run install:macos` starts successfully from a remote DEX request.
2. The request drops at node replacement.
3. Gateway may recover while the node remains absent, or services repeatedly cycle.
4. A reloader/helper job is still active or respawning.

### Validated repair

- Stage **all** LaunchAgent definitions before replacing any live service.
- `plutil -lint` each staged definition.
- Return the invoking DEX request before replacement begins.
- Delegate replacement to a separate launchd-owned **one-shot** helper with `RunAtLoad` and **no `KeepAlive`**.
- Use one fixed helper label, unload the prior inactive helper before reuse, and remove its plist after completion.
- Record installer state separately from the calling request.
- Bound compatibility-backend shutdown instead of waiting indefinitely for SDK close.

The final live proof showed the install command returning exit 0, the expected brief disconnect, gateway/node reconnection on 0.3.1, a stable node PID after the restart window, and no repeating helper cycle.

### Regression/prevention controls

- `tests/audit.test.ts`: one-shot helper must have `RunAtLoad` and must not contain `KeepAlive`.
- `docs/GOLDEN_WORKER.md`: self-hosted install + reconnect is a required release path.
- `npm run install:macos` is the supported persistent update/restart path.
- Direct remote `launchctl kickstart -k` is not a substitute for self-hosted installation; by definition it can destroy the request invoking it.

### False leads to avoid

- A successful `npm run build` says nothing about service replacement lifecycle.
- A gateway returning does not prove the node returned.
- A helper process existing does not prove it is one-shot; `KeepAlive`/respawn behavior must be inspected.
- Retrying the same self-killing inline restart from DEX is not recovery.

---

## Incident B — stale-lock recovery could delete a new owner's lock

### Confirmed symptom

The receipt concurrency test intermittently failed: concurrently appended signed receipts did not always form one predecessor-linked chain. Focused runs could pass repeatedly, but repeated **full-suite** execution reproduced the failure.

### Root cause

The shared file-lock helper had a TOCTOU race in stale-lock recovery:

1. waiter B saw the primary lock already existed;
2. owner A finished and removed that lock;
3. B's recovery check observed the path missing and treated that as recoverable;
4. owner C acquired a new lock at the same path;
5. B unlinked the path it believed was stale, deleting C's new lock;
6. two writers could then enter the protected receipt mutation and fork the chain.

The defect was in the common state-lock primitive, not receipt hashing or Ed25519 signing.

### Fast recurrence signature

- a concurrency fixture fails only under heavier/full-suite scheduling;
- isolated reruns often pass;
- signed individual records can still verify, but predecessor linearity or a lost-update assertion fails;
- the affected state mutation uses the common file lock.

### Validated repair

`withFileLock` now:

- gives each acquired primary lock an ownership token and records its inode/device identity;
- never treats a merely disappearing lock path as stale;
- serializes stale-owner recovery with a separate recovery guard;
- forces normal acquirers that cross the recovery-guard race to relinquish their primary lock;
- releases a lock only if the pathname still refers to the inode that owner actually acquired;
- recovers a truly dead/stale owner without evicting a live owner just because it is slow.

### Regression/prevention controls

- `tests/state-io.test.ts`: starts with a deliberately stale dead-owner lock and launches 40 concurrent claimants; maximum simultaneous critical-section occupancy must remain exactly one.
- `tests/receipts-plans.test.ts`: concurrent receipts must form one verified linear chain.
- Post-fix proof: five focused lock/receipt stress runs, three complete regression runs, and the deployed golden-worker run passed.
- Any future change to `withFileLock`, policy/grant reservations, plans, receipts, node auth, revocations, bootstrap, or OAuth persistence must rerun the concurrency subset and complete suite.

### False leads to avoid

- Do not rewrite receipt hashing/signature code merely because the chain assertion fails.
- Do not downgrade a full-suite-only concurrency failure to “flaky” after a few isolated green runs.
- Do not make lock staleness time-based for a live PID; a slow owner is still the owner.
- Do not unlink a lock pathname after observing an earlier generation without proving the current pathname still belongs to that generation.
