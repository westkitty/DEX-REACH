# C14/C15 consolidated owner decision packet — 2026-10-10

Source state: branch `c14-chaos-recovery`, pushed at `4192838935b8a412354207b88137c1ff58e12c6b`. PR #16 is draft and targets `c13-worker-repair`; PR #15 is draft and targets `main`. Installed runtime: C13 `0.3.2-87a99494ebb3-2f44ae46b11b`, unchanged by this campaign.

Verdicts: C13 NOT PASS · E7 HOST CAPABILITY BLOCKED · C14 source hardening continued (see below) · C14 program PARTIAL · C15 BLOCKED (the master plan requires C14 PASS plus install authority).

The master plan's C14 exit gate requires "a completely fresh chaos pass", including killing and restarting host services, on the representative Mac. C15 requires C14 PASS and explicit commit/push/deploy/install authority. Neither can be satisfied from source work alone. The decisions below are the smallest set that would unblock the remaining program. Each decision states what stays blocked if it is declined.

## 0. RESOLVED 2026-10-10 18:40 EDT by owner-authorized option (a); see OPERATIONAL_STATE. Original finding: installed services were down (observed read-only, 2026-10-10 17:50–18:05 EDT)

- **Host restart:** the host restarted at about 17:50 EDT. `ps` works again, and no hung `ps` processes remain.
- **All five services down:** gateway, node, coordinator, worker and oauth-canary all exit with code **78 `EX_CONFIG`** and sit in launchd `spawn scheduled`. Nothing listens on 127.0.0.1:8787, so the public connector is down.
- **Root cause:** every LaunchAgent runs `/opt/homebrew/Cellar/node/26.11.0/bin/node`. Homebrew upgraded Node to 26.11.1 at 16:54 EDT and removed the 26.11.0 keg. That path no longer exists. This campaign did not run Homebrew.
- **Earlier symptoms:** the pre-restart `ps` wedge and the offline node (16:41 onward) overlap that upgrade window. Their exact relationship is unproven, and this campaign's concurrent stress testing is not ruled out as a contributor.
- **Source repair** (on this branch, not installed): installers now pin `<prefix>/opt/node/bin/node`. They use it only when it resolves to the exact interpreter performing the install, and otherwise keep the exact path (`stableNodeBin`, `scripts/lib/service.ts`, `tests/service-node-binary.test.ts`). The C13 runtime is unchanged.
- **Live recovery options** (owner choice; each restarts services):
  - **(a) Smallest:** rewrite only the interpreter path in the five installed LaunchAgents from the 26.11.0 Cellar path to `/opt/homebrew/opt/node/bin/node`, then bootstrap them. The C13 release is unchanged, but runs under Node 26.11.1.
  - **(b) Reinstall:** reinstall C13 `87a99494` through the immutable installer from a checkout that carries the repair.
  - **(c) Install the C14 candidate:** this is decision 2, step 3, and needs the backup prerequisites first.
- **Verification after recovery** (read-only): five services `running`, `/healthz` `onlineNodes:1`, the installed release identity unchanged, and a fresh task report showing 19 (or newly counted) unresolved records untouched.

## 1. Approve compat-home opaque link preservation (policy only, no live mutation)

- **Action:** permit live certification to use `COMPAT_HOME_PRESERVATION_RULE` (`scripts/lib/recovery-symlinks.ts`).
- **Effect:** the six compat-home links (4 internal, 1 dangling pnpm registry link, 1 registry link escaping the state root) are preserved as exact link bytes and never dereferenced or repaired.
- **Evidence:** a read-only hypothetical scan showed compatibility `INCLUDED` with all six preserved. See [root causes](../c14-recovery/C14_COVERAGE_ROOT_CAUSES.md).
- **If declined:** compatibility remains `BLOCKED_BY_LINK_POLICY`, and no live backup can certify.

## 2. One bounded maintenance window on MacBook-Air.local (after decision 0)

The installed C13 runtime has no checkpoint participant, so a coordinated live backup of the C13 state needs either a C14 install or all services stopped. The smallest consistent route is:

1. **Fresh read-only preflight and task report:** confirm 19 unresolved records (or a newly counted figure), zero leases/tickets, and the exact host, account and HEAD.
2. **Offline capture:** stop the five services (`launchctl bootout`, LaunchAgents unchanged), capture to one owner-selected private destination and volume, run an isolated application restore under an independently stored expectation, then restart the same C13 services. Source work still needed first: `liveCapture()` refuses today. A service-stopped live capture adapter must be implemented and reviewed on this branch before this step. It is not implemented yet.
3. **Install the C14 candidate:** use the existing immutable installer, retain C13 as Last Known Good, and verify release identity and the five services. This also deploys the admission wait-status repair that stops the task-journal flooding.
4. **Physical chaos sequence:** kill and restart the gateway, node, coordinator and worker at the task phases listed in master plan C14 item 1. Reconcile every uncertain outcome before any retry.
5. **Rollback proof:** roll back to C13 Last Known Good, then forward again.

- **Risk:** service interruption for the duration of the window. The connector is unavailable while services are stopped.
- **Preservation:** the C13 release and capsules are retained, there is no task replay, no owner policy change, and no connector administration.
- **If declined:** C14 program stays PARTIAL and C15 stays BLOCKED.

## 3. Historical task disposition (19 records)

- **State:** 17 PREPARING `AMBIGUOUS_EFFECT` (`dex.process.run` ×13, `dc.call` ×2, `dex.plan` ×2) and 2 RUNNING `dex.file.read` `INSUFFICIENT_EVIDENCE`. None is provably resolved, `replayAuthorized=false`, and no disposition command exists.
- **Decision:** leave them preserved as-is, or authorize designing an append-only owner-acknowledgement contract. That would add an owner disposition event and never rewrite history, invent results or replay.
- **If declined:** the records remain unresolved, and the preflight's unresolved-task prerequisite stays false. This blocks installation under the current preflight contract unless the contract is amended.

## 4. E7 scope

- **State:** the hosted connector disable/re-enable capability does not exist in the available host. A local simulation is not hosted-client interruption proof.
- **Decision:** keep E7 as an explicit external blocker and accept a narrowly scoped local/runtime release without it, or keep the release blocked.

## 5. DEX repository (separate authority)

- **State:** local `/Users/andrew/DEX` `main` is 21 commits ahead of `origin/main` (`57693da`) and has 12 uncommitted modified files in capsule, museum, remix, session, sidequest and e2e.
- **Not done:** this campaign made no changes there, and the master plan's C8–C12 work (manifest-driven 50-command router, product adapters in REACH) remains NOT IMPLEMENTED on the REACH side ([conformance](C14_ECOSYSTEM_CONFORMANCE.md)).
- **Decision:** authorize a separate DEX session to reconcile and publish that work, or keep it out of this release.

## 6. Merge order (only after C14 PASS)

- **Order:** PR #15 → `main`, then PR #16 rebased or retargeted onto the resulting `main`, each with exact-HEAD hosted checks.
- **Current state:** not requested now, and both PRs stay draft.

## Smallest next action

Decision 0(a): repoint the five installed LaunchAgents at `/opt/homebrew/opt/node/bin/node` and bootstrap them, then confirm `onlineNodes:1`. Every other live step depends on running services.
