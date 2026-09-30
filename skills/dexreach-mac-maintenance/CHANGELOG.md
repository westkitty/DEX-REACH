## 2.3.1

- Add a bounded, read-only `status --target macbook` JSON contract for local UI integrations.
- Report current APFS free space and pressure, watcher activity, and the most recent persisted run/reclaim summary without performing candidate discovery or mutation.

# Changelog

## 2.2.2 - 2026-09-21

- Replaced the generic `assets/icon.svg` UI asset with the skill-specific `assets/dexmaint-icon.svg` and updated `agents/openai.yaml`, preventing cross-Skill icon-name collisions.
- Added regression coverage requiring the unique icon path and forbidding a generic `assets/icon.svg`.
- No maintenance workflow, kernel, cleanup policy, trigger, or Drive semantics changed from 2.2.1.

## 2.2.1 - 2026-09-21

- Corrected the packaged DEX//MAINT UI icon so `assets/icon.svg` matches the installed maintenance/magnifier identity referenced by `agents/openai.yaml`.
- No workflow, kernel, policy, trigger, or cleanup semantics changed from 2.2.0.

## 2.2.0 - 2026-09-21

- Split storage reporting into immediate free, potentially purgeable, and DexCleaner available-for-work metrics; added freshness and goal-binding rules.
- Added absolute storage goals with explicit `immediately-free` or `available-for-work` semantics.
- Promoted narrowly proven rebuildable Codex staging/cache, Gradle wrapper/daemon, uv cache, and node-gyp cache categories with apply-time live/config guards.
- Added a formal candidate-promotion gate so cache/tmp/staging labels cannot become automatic deletion authority without lifecycle proof.
- Made Drive preservation idempotent: probe exact destination before upload, reuse matching remote objects, block mismatches, and reconcile remote MD5 after timeout/failure.
- Persisted Drive destination and archive-attempt state on durable tickets; added duplicate-match warnings and transport-health metadata.
- Added durable menu provenance to tickets so partial batches can map original numbers to fresh-menu numbers.
- Added a bounded read-only hotspot scanner for deep hidden-space reconnaissance instead of uncontrolled whole-home recursive scans.
- Added regression coverage for the storage-metric, promoted-cache, Drive-timeout, duplicate-remote, and protected-live-path cases.

## 2.1.0 - 2026-09-18

- Added bounded storage reconnaissance across user-visible folders for large individual files and older installer/archive payloads.
- Added report-only `~/Library` namespace hotspots to identify where additional storage investigation may be worthwhile without granting deletion authority.
- Added a hash-locked numbered optional-cleanup menu after inspection/cleanup runs.
- Added exact numbered maintenance selection via `plan-selected`; selected cleanup cannot broaden to unchosen categories.
- Added durable numbered candidates with separate `remove <n>` and `drive <n>` actions; bare durable numbers never delete.
- Added exact size/mtime/path revalidation before a numbered durable candidate can enter the durable ticket lane.
- Added menu tamper/staleness blocking and independent measurement windows for selected follow-up cleanup.

## 2.0.0 - 2026-09-18

- Rebuilt the workflow around a deterministic DEX//MAINT remote kernel.
- Made MacBook the only implicit/default machine.
- Added a hard current-request trigger requirement for every Big Mac action.
- Replaced freeform deletion commands with manifest-locked kernel mutations.
- Added APFS-aware storage measurement, process revalidation, symlink refusal, repository protection, and durable run ledgers.
- Added process leases for safely reclaiming known temporary development/test processes.
- Added optional Google Drive preserve-then-remove for explicitly selected durable material; caches and regenerable debris are excluded.
- Added verified rclone Google Drive transport with fixed archive namespace and post-copy verification.
- Added durable file/directory tickets that block removal if content changes after review.
