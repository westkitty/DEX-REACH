# C14-G cold-start recovery report

## Verdict

**C14-G: PASS for isolated source reconstruction; PARTIAL for independent evaluation.**

A fresh detached worktree was created from `bae8492d2e960f15b2684e0f3645b2206877b8b1` with a new dependency installation. The repository supplied enough information to build and resume current source work without owner credentials, installed services, connector state, or prior chat history.

The second blind pass is **UNVERIFIED**. This report is a bounded reconstruction by the current executor, not an independent evaluator.

## Frozen initial classification

| Fact | Classification | Evidence or limitation |
| --- | --- | --- |
| Project purpose and authority model | RECOVERABLE | `README.md`, `OPERATIONAL_STATE.md`, protocol and operation catalogs |
| Current branch and source baseline | RECOVERABLE | `c14-chaos-recovery`, exact HEAD `bae8492d2e960f15b2684e0f3645b2206877b8b1`, origin parity before work |
| Current phase | RECOVERABLE | C14 source campaign active; C13 NOT PASS, E7 BLOCKED, C15 not started |
| C14-A through C14-F evidence | RECOVERABLE | `docs/C14_EVIDENCE.md` and linked raw reports |
| Installed release identity | STALE / SEPARATE | Historical installed C13 evidence is recorded in `OPERATIONAL_STATE.md`; source HEAD is not installed and no installation was attempted |
| Governing master plan DOCX | MISSING | `docs/C14_PREPARATION.md` records that the original DOCX was not located; checked-in requirement maps and ADRs are available |
| C14 preparation authorization sentence | STALE | Historical packet said C14 implementation was unauthorized; current owner directive authorizes bounded source work, while C13/E7 status is unchanged |
| Full-suite aggregate and hosted CI | UNKNOWN | Prior evidence says full suite and hosted CI were not closed for this branch |
| Required Node/TypeScript/tsx toolchain | RECOVERABLE | `package.json`, `package-lock.json`, `tsconfig.json`, declared npm scripts |
| Owner secrets and live service state | NOT REQUIRED / PROTECTED | Isolated source checks use temporary state; no credentials or services were accessed |
| Independent cold-start evaluation | AMBIGUOUS | No separate evaluator context was available |

## Fresh reconstruction

Disposable worktree: `/tmp/dex-c14-g.dtHsF9` (detached at the verified source SHA). `npm ci` completed successfully from the lockfile. It reported six moderate dependency advisories and deprecated transitive packages; no dependency changes were made.

The fresh worktree passed:

- `npm run typecheck`
- `npm run invariants -- --check` — 42 release-blocking invariants
- `npm run build`
- focused C14-A/C14-C/C14-E/C14-F tests — 10/10 PASS
- `npm run verify:clean-build` — 160 artifacts rebuilt byte-for-byte from tracked source in a different directory with a fresh install

The source declares safe local entry points in `package.json`: typecheck, invariants, build, isolated tests, `verify:clean-build`, and source-only verification. No hidden globally installed compiler or undocumented source file was needed.

## Hidden-dependency audit

The reconstruction exposed and corrected one current-state documentation defect: `docs/C14_PREPARATION.md` still described C14 implementation as unauthorized even though current evidence and owner authority permit bounded C14 source work. A dated current-state note now marks that packet historical without rewriting its original entry-gate record.

The repository documents the important environment boundaries: `DEX_REACH_STATE_DIR` for isolated task/coordinator state, `DEX_REACH_ENV_FILE` for explicit local secrets, and gateway/node variables for live operation. The clean build and fresh install did not require those live values. No broken build command was found in the exercised scope.

The following limitations remain explicit rather than repaired here:

- the missing original master-plan DOCX;
- installed-runtime identity is separate from source identity;
- full suite and hosted CI are not established by this cold pass;
- physical service, connector, second-host, and human acceptance remain outside isolated reconstruction.

## Bounded recovery runbook

1. Confirm the repository root, branch, exact HEAD, remote parity, and clean status.
2. Read `README.md`, `OPERATIONAL_STATE.md`, `docs/C14_EVIDENCE.md`, the relevant ADR, and the active campaign ledger.
3. Create a detached disposable worktree from the verified source SHA.
4. Run `npm ci`, `npm run typecheck`, `npm run invariants -- --check`, `npm run build`, and the packet-specific focused tests.
5. Use temporary `DEX_REACH_STATE_DIR` for any durable-state or coordinator fixture; never point tests at `~/.dex-reach`.
6. Run `npm run verify:clean-build` when source reproducibility is material.
7. Record source, runtime, test, CI, installation, and physical-acceptance states separately.
8. Remove only the exact disposable worktree after evidence capture.

## Boundaries

This proves source reconstructability and clean-build reproducibility. It does not prove an installed runtime, a real connector, physical chaos, or an independent second evaluator. The installed C13 runtime, owner task store, credentials, policies, services, Big Mac, and `main` were not changed.
