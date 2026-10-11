# Remote branch disposition ledger — 2026-10-11

Scope: every remote branch of `westkitty/DEX-REACH` on 2026-10-11, measured against the validated feature `arena/9964f15d-dex-reach` (`20a496a`) that the mainline-consolidation integration branch is built on. `main` was `175d58b`, 0 commits ahead of and 107 behind that feature.

Method: `git merge-base --is-ancestor` for containment; `git cherry` for patch identity; `git merge-tree --write-tree` for conflict status; and a read of each branch's own diff against the current code where the branch is ahead. Containment means every commit is reachable from the feature, so nothing on the branch can be lost by the merge. No branch was deleted, reset or force-pushed. Every branch below remains a recoverable remote ref.

## Contained: no unique work (12 branches + 2 PR heads)

| Branch | SHA | Evidence |
| --- | --- | --- |
| `c14-chaos-recovery` (PR #16 head) | `d337597` | Ancestor of the feature; the feature merges it. |
| `c13-worker-repair` (PR #15 head, base `main`) | `391d0b0` | Ancestor of the feature. |
| `campaign/c2-c6` | `55f1d9a` | Ancestor. |
| `fix/chatgpt-oauth-refresh` | `70f4d3d` | Ancestor. |
| `fix/coordinator-startup-test-timeout` | `566b804` | Ancestor. |
| `fix/immutable-installed-runtime` | `723d7dc` | Ancestor. |
| `fix/immutable-runtime-bootstrap` | `f65fc99` | Ancestor. |
| `fix/oauth-refresh-proof-canary` | `80b6885` | Ancestor. |
| `fix/owner-auth-recovery` | `ad8882e` | Ancestor. |
| `fix/public-origin-validation` | `cc6d3ac` | Ancestor. |
| `fix/smoke-sep2352` | `847b34d` | Ancestor. |
| `harden/oauth-reliability-20260923` | `63fe742` | Ancestor. |
| `perf/bounded-performance-pass` | `15878d4` | Ancestor. |

Remaining action: none. After the merge these are reachable from `main`. They are candidates for deletion by the owner (see the end of this file); this work deletes none.

Local-only branches in this clone's worktrees (`c1-architecture-contracts`, `c13-e8-control-room`, `fix/coordinator-epipe-reload`, `claude/peaceful-keller-894b2d`) are also ancestors of the feature and exist on no remote.

## Diverged: unique commits relative to the feature

| Branch | SHA | Unique | Decision |
| --- | --- | --- | --- |
| `claude/work-coordinator-cpcug3` | `dbc7a51` | 1 | **Integrated in part** |
| `repair/control-plane-resilience-20260929` (PR #12) | `ee88972` | 95 | **7 integrated, 88 retained** |
| `fix/staged-live-build` | `99e196f` | 1 | **Retained** |
| `feature/familiar-bus-wave-2` (PR #1) | `fa9861b` | 3 | **Retained** |
| `fix/macos-node-boot-hardening` (PR #13) | `d203c81` | 6 | **Retained** |

### `claude/work-coordinator-cpcug3` — integrated

One docs-only commit (2026-09-20). `docs/EXPANSION_RECORD.md` still listed the real-client acceptance as the open release blocker after `OPERATIONAL_STATE.md` had recorded it closed (trace `7e58bf5e2dff5b8e96bdcd4ec84f0ee0` is present in the feature's state record). The file was unchanged on the feature line since the branch point, so the branch version applied without loss: integrated as `3e7859b`. The same commit's `OPERATIONAL_STATE.md` edit was **not** taken, because that file is append-only and is now at revision 96 against the branch's 56.
Remaining action: none.

### `repair/control-plane-resilience-20260929` — 7 integrated, 88 retained

A 95-commit, 31-file line from 2026-09-29/30, built before the C13/C14 work. It is **not** merged wholesale: 66 of the remaining 88 commits conflict when applied to the integration head, and the other 22 apply textually only as steps of stacks whose neighbours conflict. The conflicts sit in code that C13/C14 rebuilt: `scripts/install-macos.ts`, `scripts/reload-launchagents.ts`, `src/node/main.ts`, `src/shared/protocol.ts`, `src/gateway/registry.ts`, `src/shared/workspace-worker.ts`. None of its six new modules (`install-lock`, `launchd-transition`, `plist-rollback`, `process-deadline`, `rollback-sequence`, `src/node/resilience`) exists on the feature, and the feature has its own rollback and reload machinery (`runtime-rollback.ts`, `service-reloader.ts`).

Integrated by `git cherry-pick -x`, each clean and self-tested, none touching a C14 contract:

| Source | Change |
| --- | --- |
| `7f1c6b4`, `734fd81` | Owner settings resolve outside a virtualized compatibility `HOME` (`ownerSecretsFile`). |
| `46faa7a`, `ce30e33`, `16f6b5e` | Bounded retry of transient ADB discovery failures. `dex.adbDevices` is `PURE_READ_IDEMPOTENT`, so retry is within ADR-0002. |
| `554ece6`, `4823c07` | The OAuth runtime-health diagnostic reads machine state, not a virtual `HOME`. |

Retained, by theme, with the reason each cannot be taken safely now:

| Theme | Commits (examples) | Blocker |
| --- | --- | --- |
| Node registration acknowledgement; socket-open versus registered state | `614654f`, `472c92c`, `558377b` | Changes the node/gateway wire protocol and registry; needs an ADR-0003 capability decision and C14 node-authority regression proof. |
| Backend-independent node availability; degraded compatibility state | `2f92169`, `f7394d6`, `91fbcb8`, `701837a`..`828b3ec` | Rewrites `src/node/main.ts` boot flow, which C14 reworked heavily. |
| Heartbeat tolerance of event-loop stalls | `1d7e795`, `06e9619`, `0f7addd` | `src/node/main.ts` conflict; alters disconnect semantics, which the C14 reconnect work also touches. |
| Installer transactions, install lock, proof-before-persist, rollback ordering | `13f4299`..`efe73fb`, `a9ccac4`, `8f429b6`, `571d553`, `052358c` | The installer was rebuilt after the branch; a merge needs a real macOS launchd run (E7 is host-capability blocked, and installing is out of authority here). |
| Canary deadline and launchd unload/bootstrap settling | `a1e8afc`, `a30394d`, `11fced7` | Same installer/reloader conflict and the same host-proof requirement. |
| Workspace-worker transport fallback; state-lock contention tolerance | `c046d31`, `ebafdc4`, `e6602d2`, `af16782` | A fallback path in the worker needs a security review against C13/C14 worker repair; `state-io` timing affects admission. |
| Resilience invariants and incident docs | `f83735f`, `51b9aca`, `b0e583d`, `ee88972` | They assert behaviour whose code is retained; adding the invariants without the code would make them false. |

Remaining action: the owner decides whether to carry this line forward as a rebase onto the installer as it now exists, theme by theme, each with host proof, or to mark it superseded. PR #12 stays open and draft.

### `fix/staged-live-build` — retained

One commit that replaces `prebuild` + `tsc` with a staged, lock-guarded `build-atomic` script so a build never deletes the live `dist/`. The installer path no longer depends on `dist/`: `scripts/lib/runtime-release.ts` compiles into a private release directory and documents the same hazard. What remains is a developer's `npm run build` against a legacy checkout-run service. Changing the canonical build command would also change what `reproducible-build`, `verify:clean-build` and release provenance exercise, and a killed build leaves `.dist-build.lock` behind, which then refuses every later build.
Remaining action: owner decision on whether any service still runs from a checkout's `dist/`. If none does, mark superseded.

### `feature/familiar-bus-wave-2` (PR #1) — retained

Three commits adding `src/shared/familiar.ts` and a `familiar` field on node listings. The feature has no familiar code at all, so this is new, unreviewed product surface, not a missing fix: it changes the shape of node listings that remote clients see. It conflicts in `src/gateway/registry.ts`.
Remaining action: product review of the added listing field and its privacy surface; PR #1 stays open and draft.

### `fix/macos-node-boot-hardening` (PR #13) — retained, blocked

Six commits, 26 files, validated on its own base by its author (277/277 tests, hosted checks green, two real `update:macos` runs on a Mac). It adds modules the feature lacks (`macos-config`, `macos-health`, `healthz-assert`, `assert-runtime-entry`, `RUNBOOK-macos.md`) and changes node boot, config validation (exit 78), idempotent release hashing and gateway-before-node launch. Six files conflict (`package.json`, `scripts/install-macos.ts`, `scripts/reload-launchagents.ts`, `src/node/main.ts`, `src/shared/workspace-worker.ts`, `tests/runtime-release.test.ts`), all in code the feature changed substantially (`src/node/main.ts` alone by 385 lines).
Blocker: a correct merge is a semantic reconciliation of the installer and node boot path, and it can only be proven by installing on a macOS launchd host, which is outside this work's authority.
Remaining action: a dedicated reconciliation on a host where the installer may be run, then PR #13 can be rebased and re-proven.

## Safe deletion candidates (owner decision; nothing was deleted)

Branches whose every commit is reachable from the feature, and will be reachable from `main` after the merge: `campaign/c2-c6`, `fix/chatgpt-oauth-refresh`, `fix/coordinator-startup-test-timeout`, `fix/immutable-installed-runtime`, `fix/immutable-runtime-bootstrap`, `fix/oauth-refresh-proof-canary`, `fix/owner-auth-recovery`, `fix/public-origin-validation`, `fix/smoke-sep2352`, `harden/oauth-reliability-20260923`, `perf/bounded-performance-pass`, `c13-worker-repair`, `c14-chaos-recovery`, and `arena/9964f15d-dex-reach` once merged. `claude/work-coordinator-cpcug3` is a candidate once its single commit is accepted as integrated. Do **not** delete the five diverged branches above that are marked retained.
