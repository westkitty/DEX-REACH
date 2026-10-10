# C14/C15 consolidated owner decision packet — 2026-10-10

Source state: branch `c14-chaos-recovery`, pushed at `4192838935b8a412354207b88137c1ff58e12c6b`. PR #16 is draft and targets `c13-worker-repair`; PR #15 is draft and targets `main`. Installed runtime: C13 `0.3.2-87a99494ebb3-2f44ae46b11b`, unchanged by this campaign.

Verdicts: C13 NOT PASS · E7 HOST CAPABILITY BLOCKED · C14 source hardening continued (see below) · C14 program PARTIAL · C15 BLOCKED (the master plan requires C14 PASS plus install authority).

The master plan's C14 exit gate requires "a completely fresh chaos pass", including killing and restarting host services, on the representative Mac. C15 requires C14 PASS and explicit commit/push/deploy/install authority. Neither can be satisfied from source work alone. The decisions below are the smallest set that would unblock the remaining program. Each decision states what stays blocked if it is declined.

## 0. Urgent: live host and node health (observed read-only, 2026-10-10 ~17:40 EDT)

- **`/bin/ps` hangs system-wide:** it ignores even `alarm`, an uninterruptible kernel wait. Capacity sampling and the coordinator depend on `ps`. `withFileLock` liveness checks use `process.kill(pid, 0)` and do not. 72 hung `ps` processes exist, most reparented after their parents exited (this campaign's interrupted test runs and manual probes, plus samplers). The installed coordinator holds one. `execFile` timeouts cannot reap a process in an uninterruptible wait.
- **Installed node offline:** the gateway on 127.0.0.1:8787 answers `/healthz` with `ok:true, onlineNodes:0`. The node log shows 1,036 `gateway disconnected` reconnect cycles and 69 refused transport proofs or enrollment tokens. `nodes/macbook-air.local.runtime.json` was last written at 16:41. `node-auth.json` keeps being rewritten.
- **Probable common cause:** the `ps` wedge, which began about 16:41–16:44. During the preceding hour this campaign ran heavy local stress tests (many concurrent integration suites). Contribution from that load is possible and is not ruled out. No installed file, service, credential or policy was modified by this campaign.
- **Action (owner):** inspect, then restart the host (or at least recover `ps`). Afterwards, confirm read-only that `onlineNodes` returns to 1 before any other window. If the node still refuses after a clean host restart, treat that as a separate enrollment incident, because the log says re-enrollment may be required. Do not re-enroll without diagnosis.

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

Decision 0: recover the host so that `ps` returns and the installed node is online again. Every other live step depends on a healthy host.
