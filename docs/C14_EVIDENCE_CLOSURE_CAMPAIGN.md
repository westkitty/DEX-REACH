# C14 evidence-closure campaign record

This is the durable continuation record for the extended C14 campaign. It is
source-only unless a packet explicitly records an authorized external boundary.
It never supersedes the installed-runtime metadata in the operational-state
header.

## Baseline

- Worktree: `/Users/andrew/dex-reach-c13-worker-repair`
- Branch: `c14-chaos-recovery`
- Starting/current source at campaign start: `07cbf95ebeb43d3487681e81b711bb106adf43a5`
- Remote parity at start: PASS
- Installed baseline: retained C13 candidate, separate from current source
- C13: NOT PASS
- E4: PASS
- E7: BLOCKED — HOST CAPABILITY
- C15: BLOCKED / NOT STARTED

## State model

| Dimension | Current state | Evidence |
| --- | --- | --- |
| INSTALLED_RUNTIME | Historical C13 candidate preserved; not changed | `OPERATIONAL_STATE.md` metadata header and C13 recovery evidence |
| CURRENT_SOURCE | `c14-chaos-recovery`, source at `7161f95536f7ca787f1772f5afdd66c3e274f351` | Git HEAD and this record |
| LOCAL_VALIDATION | Prior 385/385 suite and native gates PASS; fresh final rerun pending only after source changes | `docs/c14-acceptance/C14_K_SOURCE_ACCEPTANCE.md` |
| HOSTED_CI | PASS on exact head through draft PR #16; no merge performed | `docs/c14-acceptance/C14_HOSTED_CI_EVIDENCE.md` |
| PROGRAM_ACCEPTANCE | PARTIAL / NOT COMPLETE | recovered-plan traceability and final gate |
| RELEASE_AUTHORITY | Not granted | `docs/C15_READINESS_PREPARATION.md` |

## Packet ledger

| Packet | Status | Evidence / next action |
| --- | --- | --- |
| A — state and authority reconciliation | PASS | Current metadata preserves installed identity; source/runtime distinction documented |
| B — master-plan recovery | PASS | `docs/c14-acceptance/C14_MASTER_PLAN_TRACEABILITY.md`; exact hash verified |
| C — hosted GitHub CI | PASS | Draft PR #16; validation run `38024604247` and CodeQL `38024604152` passed exact head |
| D — independent cold-start evaluation | UNVERIFIED | Separate context completed without an evidence-based reconstruction; no independence claim |
| E — DEX ecosystem conformance | PARTIAL / IMPLEMENTED_UNVERIFIED | `docs/c14-acceptance/C14_ECOSYSTEM_CONFORMANCE.md`; no REACH product consumer exists |
| F — isolated chaos/observability | PARTIAL | Existing safe fixtures pass; dedicated durable node/worker interruption and installed observability remain open |
| G — adversarial C14 acceptance | PASS source / PARTIAL program | `docs/c14-acceptance/C14_FINAL_EVIDENCE_GATE.md` |
| H — owner decisions/C15 handoff | READY FOR OWNER DECISION | `docs/c14-acceptance/C14_OWNER_DECISION_PACKET.md`; C15 remains blocked |

## Protected scope

No install, service restart, launchd change, deploy, connector administration,
credential or enrollment change, owner policy/root/grant/budget change, Big Mac
action, physical chaos, merge, PR #15 change, or separate DEX-repository edit
is authorized. Historical failures, ambiguity, and owner evidence remain
preserved.

## Resume rule

After every cohesive source milestone: inspect the exact diff, run applicable
focused validation, commit only intended files, push `c14-chaos-recovery`,
verify remote parity, update this ledger and `OPERATIONAL_STATE.md`, then move
to the next independent packet. Do not claim program PASS from source-only
evidence.
