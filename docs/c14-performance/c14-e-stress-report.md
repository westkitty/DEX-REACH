# C14-E bounded long-session stress report

## Verdict

The corrected isolated stress runner passed its bounded scenarios. The sustained run completed 607.7 seconds and 2,134 cycles at concurrency 2 with zero failed cycles. The packet remains **PARTIAL**:

- the first harness revisions omitted the temporary DEX_REACH_STATE_DIR assignment and appended synthetic coordinator history to the owner namespace;
- the sustained 10-minute run predates the source repair and was executed from a dirty working tree, so it has no exact committed source SHA;
- the repair was confirmed by a matched 75.4-second smoke run, not by a second 10-minute run.

The active owner coordinator state was re-read after cleanup: zero leases, zero tickets, and `degraded=false`. Historical C14-tagged entries appended by the initial harness remain preserved. No owner credentials, task payloads, service definitions, gateway, connector, installed runtime, Big Mac, or network endpoint was used by the corrected runs.

## Artifacts

- Harness: [scripts/c14-stress.ts](../../scripts/c14-stress.ts), exposed as `npm run stress:c14`.
- Sustained raw report: [c14-e-stress-results.json](c14-e-stress-results.json).
- Post-repair matched smoke: [c14-e-smoke-final.json](c14-e-smoke-final.json).
- Repair: conditional unchanged-status persistence in [src/node/boot-recovery.ts](../../src/node/boot-recovery.ts).
- Regression: repeated recovery preserves `updatedAtUtc` and event count in [tests/c14-security-privacy.test.ts](../../tests/c14-security-privacy.test.ts).

## Conditions

Both corrected runs used a synthetic temporary state directory, restored the process environment, and removed that exact directory after reporting. The runner used Darwin arm64, Node v26.11.0, eight CPUs, an 8 GiB host, concurrency 2, five-second sampling, a 60-second result TTL, and a 512 MiB process RSS ceiling. No installed service, owner namespace, credential, connector, gateway, or network dependency was required by the corrected runner.

The sustained report recorded `memory_pressure -Q` separately during the run; system-wide free memory was observed at 37%. This is an environmental observation, not a causal attribution.

## Sustained result

The sustained pre-repair run completed 2,134 cycles: 853 normal completions, 214 controlled failures, and 119 ambiguity/recovery cycles. It recorded zero cycle failures and zero operation failures.

| Point | RSS | Heap used | Task store | Result store | Event log | Ambiguous tasks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Early, 5 s | 81.9 MiB | 18.9 MiB | 49 KiB | 10 KiB | 53 KiB | 2 |
| Middle, 310 s | 199.8 MiB | 34.2 MiB | 1.28 MiB | 282 KiB | 638 KiB | 84 |
| Late, 605 s | 211.6 MiB | 63.7 MiB | 1.84 MiB | 406 KiB | 653 KiB | 119 |

The bounded retrieval, pagination, coordinator admission/queue/release, failure, ambiguity, no-replay, result persistence, and event persistence scenarios all completed. Indexed task reads remained in the low single-digit milliseconds; coordinator acquire remained approximately 22–25 ms median in the sustained run. These are observations, not universal thresholds.

Cleanup evidence was exact to the synthetic state: zero leases, zero tickets, 119 expected nonterminal ambiguous tasks after the sweep, 1,067 archived terminal tasks, 853 expired results, no socket, and `temporaryStateRemoved=true`=true.

## Reproduced defect and repair

Repeated reconciliation of protected ambiguous tasks drifted from approximately 96 ms median early in the run to 2.27 seconds late, with late p95 at 6.26 seconds. The demonstrated cause was repeated persistence of an unchanged recovery status, including task-store and event work.

The repair writes the recovery status only when it changes. The matched post-repair smoke held recovery latency to 107.66 ms early, 119.46 ms mid-run, and 121.33 ms late; corresponding p95 values were 108.58, 144.41, and 162.87 ms, with zero failed cycles. This is bounded confirmation of the repair. No post-repair 10-minute result is claimed.

## Preservation incident and boundaries

The initial harness revisions were corrected after discovery. Their owner-namespace effects were audited and active coordinator state was cleaned through the production coordinator API. The appended historical coordinator entries were not deleted or rewritten. This prevents a clean PASS claim for the isolation packet.

The evidence is source-level, bounded, and synthetic. It does not prove installed-runtime behavior, physical restart/connector chaos, Big Mac behavior, public exposure, or human acceptance. C13 remains NOT PASS and E7 remains BLOCKED. C14 overall remains incomplete.

