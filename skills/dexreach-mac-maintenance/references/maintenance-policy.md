# Maintenance Policy

The bundled deterministic kernel is the enforcement source of truth. This reference explains policy; it never expands authority beyond the kernel.

## AUTO_SAFE

Cheap, regenerable exact caches with apply-time owner checks:

- npm content cache: `~/.npm/_cacache`
- pip cache: `~/Library/Caches/pip`
- Homebrew cache: `~/Library/Caches/Homebrew`
- Codex explicit cache: `~/.codex/cache`
- Codex Library cache: `~/Library/Caches/Codex`
- Gradle daemon state/logs: `~/.gradle/daemon` when no Gradle activity is present
- uv cache: `~/.cache/uv` (not installed uv tools under `~/.local/share/uv`)
- node-gyp cache: `~/Library/Caches/node-gyp`

## SAFE_COSTLY

Regenerable material with meaningful redownload/rebuild/plugin-refresh cost. Eligible only for `DEEP_CLEAN` or an exact selected maintenance item:

- Playwright browsers: `~/Library/Caches/ms-playwright`
- Xcode DerivedData: `~/Library/Developer/Xcode/DerivedData`
- Gradle wrapper distributions: `~/.gradle/wrapper/dists`
- Codex marketplace upgrade staging: `~/.codex/.tmp/marketplaces/.staging`
- immediate Codex marketplace children matching `marketplace-backup-*`
- Codex marketplace plugin-source staging: `~/.codex/plugins/.marketplace-plugin-source-staging`
- Codex remote-plugin install staging: `~/.codex/plugins/.remote-plugin-install-staging`

The Codex policy is deliberately narrower than `~/.codex/.tmp`. Current configured marketplaces and runtimes are protected.

## Codex guards

For promoted Codex staging/cache categories:

- exact open-handle checks must succeed;
- configured staging/backup paths must not be referenced by `~/.codex/config.toml`;
- any failed lsof/config check blocks automatic mutation;
- apply-time checks repeat immediately before cleanup;
- never remove the `.codex` parent, current marketplace checkouts, sessions, databases/history, plugin cache broadly, or `~/.cache/codex-runtimes` through these rules.

## LEASED_EPHEMERAL

Temporary processes and `/tmp` roots registered by DEX workflows with a time-bounded lease. Eligible only for `PERFORMANCE` after lease expiry and command-fingerprint revalidation.

Unknown or unleased processes remain report-only.

## DURABLE_USER_DECISION

Large files and old installers/archives discovered in user-visible roots are never automatic cleanup.

- bare number = review/select only;
- `remove <n>` = explicit local removal after fresh validation;
- `drive <n>` = verified Drive preservation followed by removal;
- preserve original menu provenance in the durable ticket.

## REPORT_ONLY / PROTECTED

Library hotspots and unknown hidden-state paths remain report-only until [candidate-promotion.md](candidate-promotion.md) is satisfied.

Always protect repositories, credentials/configuration, current runtimes/toolchains, user sessions/history, local models, application state, backups without proven retention/restorability policy, system volumes, and broad parent directories.

## Reconnaissance invariants

- Default scan is bounded to declared user-visible roots.
- Deep hidden-space investigation should proceed in stages: aggregate root -> top children -> exact semantic candidate.
- Do not follow symlinks.
- Enforce bounds on time, file count, depth and returned candidates.
- Never infer disposability from size, age, extension, or parent name alone.

## Mutation invariants

- Automatic mutation uses only the bundled kernel or a native implementation with equal/stronger semantics.
- Revalidate target, policy, kernel, manifest/menu hashes, live-use state and exact paths immediately before mutation.
- Reject policy-root symlinks; do not follow symlinks during cleanup.
- Failure never grants a broader fallback.
- Historical success may prioritize inspection, never expand authority.
- Stop once the requested storage metric is satisfied.

## Storage Guardian v2.3

- Immediate APFS free bytes are the cleanup-success metric. Candidate bytes and
  measured APFS reclaim are separate fields in append-only reclaim receipts.
- Pressure is HEALTHY at 30 GiB or more, WATCH at 20–30 GiB, LOW at 10–20 GiB,
  CRITICAL at 5–10 GiB, and EMERGENCY below 5 GiB. The watcher stops at 30 GiB;
  LOW permits AUTO_SAFE only, while CRITICAL/EMERGENCY may include SAFE_COSTLY.
- Bounded observations and receipts use the existing `~/.local/state/dexmaint/`
  root. The watcher inspects registered exact hotspots, never the whole volume.
- Active runtimes/releases, cloud and Apple-managed state, Maccy history, Brave
  code-sign clones, unverified worktrees, and all unknown state remain protected.
