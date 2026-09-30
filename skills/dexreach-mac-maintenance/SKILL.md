---
name: dexreach-mac-maintenance
description: "Govern safe Mac storage and maintenance through DEX//REACH with a deterministic, manifest-locked kernel. Use when inspecting, cleaning, deep-cleaning, reclaiming disk space, reconciling DexCleaner versus APFS free-space readings, finding storage hogs, reviewing large files, cleaning proven rebuildable developer caches/staging, or Drive-preserving durable files before local removal on the MacBook. MacBook is the only implicit target. Use Big Mac only when the current user message itself says `Big Mac` or `bigmac`; never infer it from prior context."
---

# DEX//MAINT

## Purpose

Run evidence-driven Mac maintenance while keeping destructive authority inside a deterministic kernel. Distinguish storage metrics, protect project/runtime state, verify Drive preservation before removal, and stop once the requested practical storage goal is satisfied.

## Trigger conditions

Use when the current request is about Mac storage inspection/cleanup, DexCleaner/APFS storage reconciliation, reclaim/free-space goals, safe cache/staging cleanup, large-file review, maintenance Drive-preserve removal, or bounded deep storage reconnaissance. Use Big Mac only when the current request literally names `Big Mac` or `bigmac`.

## Non-trigger conditions

Do not use for arbitrary filesystem deletion, repository cleanup, generic macOS advice, software upgrades, app troubleshooting, DEX//REACH development, unrelated Drive archiving, or cross-machine offload/synchronization. Route command-only preflight to `terminal-command-preflight` when the maintenance kernel itself is not the requested executor.

## Required inputs

Resolve:

- target machine under [references/machine-model.md](references/machine-model.md);
- maintenance mode and storage-goal semantics under [references/intent-contract.md](references/intent-contract.md);
- DEX//REACH access to the selected target.

For durable menu items, require the current run/menu hash plus explicit `remove <n>` or `drive <n>` authority.

## Optional inputs

Use when supplied:

- amount to reclaim;
- absolute free/available-for-work target;
- deep-clean or performance-cleanup authority;
- deeper hidden-space reconnaissance request;
- numbered selections;
- Drive preservation choice.

## Default assumptions

- target = MacBook;
- ambiguous maintenance request = INSPECT;
- ordinary reconnaissance = bounded user-visible roots;
- durable user content = keep;
- unknown hidden data/processes = report only;
- Drive preservation = off;
- Big Mac = unavailable unless literally named in the current request.

## Feasibility limits

This Skill cannot make an offline node reachable, guarantee Drive throughput, infer whether personal files are disposable, prove unknown application state reconstructable without evidence, or guarantee DexCleaner is installed/fresh.

If DEX//REACH is unavailable, do not silently switch executors. If Drive verification fails, keep the local original. If an `available-for-work` goal lacks a fresh DexCleaner sample, block that metric rather than silently substituting immediate free space.

## Workflow

### 1. Bind target, mode and storage metric

Read [references/intent-contract.md](references/intent-contract.md) and [references/storage-metrics.md](references/storage-metrics.md).

- Bind MacBook by default.
- Require literal current-turn `Big Mac`/`bigmac` for every Big Mac action.
- Distinguish amount-to-reclaim goals from absolute free-space goals.
- Bind absolute goals to `immediately-free` or `available-for-work` before deletion.
- Stop if the requested metric is already satisfied.

### 2. Verify DEX//REACH and kernel integrity

Follow [references/dexreach-runtime.md](references/dexreach-runtime.md): list nodes, fingerprint the selected machine, stage the exact bundled kernel, run capabilities, and compare identity/version/policy/SHA with [references/kernel-integrity.md](references/kernel-integrity.md).

Any mismatch is `BLOCKED`.

### 3. Inspect before mutation

Run kernel `inspect`.

Use its evidence for:

- immediately-free APFS/Data-volume bytes;
- fresh DexCleaner potentially-purgeable and available-for-work bytes when present;
- storage pressure;
- recognized maintenance categories and live-owner state;
- memory/swap and top-process summary;
- bounded durable-file reconnaissance;
- report-only Library hotspots.

Never convert a broad cache/tmp label into deletion authority. For newly discovered hidden paths, follow [references/candidate-promotion.md](references/candidate-promotion.md).

### 4. Perform bounded deeper reconnaissance only when requested

If the user explicitly asks to scan deeper, use the bundled `scripts/storage_hotspot_scan.py` against one bounded root identified by prior evidence. Progress from aggregate root -> top children -> exact semantic candidate. Do not run uncontrolled whole-home recursive scans.

Deep reconnaissance is read-only. A discovered path must still pass [references/candidate-promotion.md](references/candidate-promotion.md) before future policy promotion.

### 5. Plan automatic cleanup

Read [references/maintenance-policy.md](references/maintenance-policy.md).

- CLEAN -> `AUTO_SAFE` only.
- DEEP_CLEAN -> `AUTO_SAFE` + `SAFE_COSTLY`.
- PERFORMANCE -> expired `LEASED_EPHEMERAL` only.
- Absolute goal -> pass the bound goal metric and stop budget to the kernel.

Apply only the locked manifest. Never replace kernel maintenance mutations with freehand deletion commands.

### 6. Verify the transaction

Run kernel `verify` after mutation.

Report separately:

- measured category delta;
- immediate APFS free-space delta;
- available-for-work delta when both fresh samples exist.

Never claim those deltas are equivalent.

### 7. Generate the optional menu

After inspection or verified cleanup, run `menu --run <RUN_ID>`.

Preserve menu hash and numbering for that run.

- Bare maintenance numbers may authorize only exact ready maintenance entries.
- Bare durable numbers are review only.
- `remove <n>` means exact local removal after revalidation.
- `drive <n>` means archive -> verify -> local removal.
- Stale menu/hash/path/metadata/owner state blocks.

If a partial durable batch causes a fresh menu to renumber remaining files, report original provenance and new numbers instead of forcing the user to reconstruct the mapping.

### 8. Drive-preserve durable data

Follow [references/drive-preservation.md](references/drive-preservation.md).

The kernel must:

- persist destination identity;
- remote-check before upload;
- avoid duplicate upload when an exact matching remote object already exists;
- block on mismatched/unverifiable destination state;
- recheck remote state after copy timeout/failure;
- require verified MD5/check receipt before local removal.

Never archive ordinary maintenance debris.

### 9. Record state and stop

Use `~/.local/state/dexmaint/` run/ticket/ledger records to explain what happened, not to expand authority.

Stop when:

- the requested metric is satisfied;
- the authorized candidate set is exhausted;
- remaining candidates require user judgment; or
- evidence becomes insufficient.

## Tool and reference guidance

- Runtime/tool order: [references/dexreach-runtime.md](references/dexreach-runtime.md)
- Machine binding: [references/machine-model.md](references/machine-model.md)
- Intent/metric binding: [references/intent-contract.md](references/intent-contract.md)
- Storage quantities: [references/storage-metrics.md](references/storage-metrics.md)
- Maintenance dispositions: [references/maintenance-policy.md](references/maintenance-policy.md)
- New-candidate proof: [references/candidate-promotion.md](references/candidate-promotion.md)
- Drive transaction: [references/drive-preservation.md](references/drive-preservation.md)
- Failure behavior: [references/failure-contract.md](references/failure-contract.md)
- Visible report: [references/output-contract.md](references/output-contract.md)

## Source grounding

Treat current machine measurements, process state, file metadata, menu/ticket records, and Drive verification as factual only when observed through the current run's tools/kernel. Preserve timestamps and metric definitions. Never infer current free space, archive success, config references, process inactivity, or deletion success from prior chat claims alone. When evidence conflicts, reconcile quantity/source/time before acting.

## Output format

Follow [references/output-contract.md](references/output-contract.md). Keep current storage semantics explicit and preserve original durable menu provenance across partial archive batches.

## Error handling

Follow [references/failure-contract.md](references/failure-contract.md). Never convert failure into broader permission, another executor, privilege escalation, wider paths, stronger cleanup, stale-number guessing, or unverified Drive removal.

## Final quality checklist

Verify:

- target binding is current-turn correct;
- kernel identity/version/policy/SHA match;
- inspection precedes mutation;
- storage goal uses the correct quantity and units;
- deep scans remain bounded and read-only;
- newly promoted paths use exact scopes with lifecycle/live/config proof;
- every automatic mutation is manifest-locked and apply-time revalidated;
- durable bare numbers never delete;
- Drive receipt is verified before local removal;
- partial archive failures keep originals;
- original menu provenance is retained;
- project/runtime/config/session/model/backup state outside policy remains untouched;
- cleanup stops when the practical goal is reached.
