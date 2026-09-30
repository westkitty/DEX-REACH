# Storage Metrics Contract

Keep three quantities distinct.

## Immediately free

Source: APFS/Data-volume free bytes from the kernel's filesystem measurement.

Meaning: storage physically free now. This is the authoritative metric for requests such as `make 35 GB actually free`, `immediate free space`, or an explicit `immediately-free` goal.

The legacy kernel field `available_bytes` is only a compatibility alias for `immediately_free_bytes`.

## Potentially purgeable

Source: a fresh DexCleaner capacity sample when available.

Meaning: bytes macOS reports as reclaimable when needed. Do not present this as already-free disk space.

## Available for work

Source: a fresh DexCleaner sample when available.

Meaning: DexCleaner's `volumeAvailableCapacityForImportantUsage`-style capacity signal. It normally incorporates immediately-free space plus capacity macOS expects it can reclaim.

Use this metric when the user explicitly refers to DexCleaner's headline reading or says the target is `available for work`.

## Freshness and reconciliation

- Treat DexCleaner as optional. Never invent its values when no fresh sample exists.
- A DexCleaner sample is usable only when its state is `Fresh` and its timestamp is within the kernel freshness window.
- Compare quantities by definition, units, source and timestamp before declaring a disagreement.
- `27.2 GB immediately free` and `35 GB available for work` can both be correct at the same time.
- Display decimal GB versus binary GiB explicitly when the distinction matters.
- Do not subtract a `df`/GiB number from a DexCleaner/decimal-GB target without normalizing units and quantity semantics.

## Goal binding

For an absolute storage goal, bind the metric before planning:

- `35 GB free` without DexCleaner context -> `immediately-free` unless the surrounding conversation clearly established another metric.
- `35 GB available for work`, `DexCleaner says...`, or a target explicitly based on DexCleaner -> `available-for-work`.
- If the requested metric is ambiguous and the choice materially changes deletion, ask or show both before mutating.

Stop when the requested metric is already satisfied. Do not continue deleting merely to maximize free space.
