# C14-E corrected isolated sustained confirmation

## Verdict

**C14-E corrected isolated sustained confirmation: PASS at source-only scope.**

The post-repair runner completed the required single sustained confirmation at the configured 660-second target. The historical pre-repair run and its isolation incident remain preserved in [c14-e-stress-report.md](c14-e-stress-report.md); this report does not replace or rewrite that evidence. C14 overall remains incomplete.

## Source and conditions

- Exact source: `5b569d8bc21fdddb132d82385ed64eefd5dba2f1`
- Branch: `c14-chaos-recovery`
- Host: `MacBook-Air.local`, Darwin arm64
- Node: `v26.11.0`
- Host memory/CPU: 8 GiB, 8 logical CPUs
- Workload: concurrency 2, 660-second target, 25,000 operation cap, 512 MiB RSS cap, 5-second sampling, 60-second result TTL
- Actual duration: 661.1 seconds
- Raw artifact: [c14-e-stress-confirmation.json](c14-e-stress-confirmation.json)

## Scenario coverage

The run completed 3,611 cycles with zero failed cycles and zero operation failures. It exercised normal durable completion, indexed task lookup, bounded listing, coordinator acquire/release, queue admission and cancellation, controlled failures, AMBIGUOUS_EFFECT preservation, duplicate execution refusal, result persistence and task binding, task-event append and pagination, periodic boot recovery, and final lifecycle cleanup.

Counts were 1,445 normal tasks, 361 controlled failed tasks, and 215 intentionally preserved ambiguous tasks. The harness assertions reported one synthetic external effect per ambiguous task and refused replay.

## Resource and latency results

| Point | Recovery median / p95 | RSS | Heap | Task store | Result store | Event log | Coordinator history | Leases | Tickets | Ambiguous |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Early, 5.0 s | 83.3 / 116.6 ms | 75.5 MiB | 15.2 MiB | 46.7 KiB | 10.0 KiB | 50.3 KiB | 14.0 KiB | 3 | 0 | 2 |
| Middle, 335.2 s | 177.0 / 326.3 ms | 218.1 MiB | 37.0 MiB | 1.88 MiB | 414.4 KiB | 543.7 KiB | 47.2 KiB | 2 | 0 | 123 |
| Late, 660.6 s | 204.1 / 304.2 ms | 261.6 MiB | 70.3 MiB | 3.14 MiB | 687.3 KiB | 543.3 KiB | 47.1 KiB | 1 | 0 | 215 |

RSS and durable stores grew with the intentionally accumulating fixture. Coordinator history stayed bounded. No resource-pressure stop fired. The post-repair recovery curve increased moderately with fixture size, but did not reproduce the pre-repair multi-second deterioration: late p95 was 304.2 ms versus the historical pre-repair 6.26 s observation. This is a bounded comparison, not a universal performance guarantee.

CPU samples and all per-operation latency samples are retained in the raw JSON artifact.

## Cleanup and invariants

The final synthetic-state check reported:

- zero leases and zero queue tickets;
- 215 active tasks, all expected AMBIGUOUS tasks;
- 215 ambiguous tasks preserved after sweep;
- 1,806 terminal tasks archived;
- 1,445 expired results;
- no test-owned coordinator socket;
- temporary fixture removed;
- no duplicated synthetic effect;
- no incorrect result binding;
- no unrelated lease removed.

The installed owner coordinator was read after the run: zero leases, zero tickets, `degraded=false`.

## Isolation

The exact workload root was `/var/folders/lm/f_zcrpb94bvg69m2y35klb8r0000gn/T/dex-c14-stress-rPhXJp`. Runtime preflight asserted that the task store, result store, task-event log, coordinator directories, lease directory, queue directory, and coordinator history all resolved beneath that root. The test socket used a separate derived path in the system temporary directory and was absent after cleanup.

The owner coordinator history digest changed from 17,783 bytes to 17,952 bytes during the interval. The new tail contains only installed-coordinator `cache-miss`, `classifier-result`, and `cache-hit` events. Because the history changed while the workload was running, attribution is recorded as **UNKNOWN**, not as proof that the workload modified owner history. No owner task store, credential, policy, service, gateway, connector, or installed runtime was touched by the corrected harness. Historical owner entries were not deleted or rewritten.

## Validation and publication

- Path-isolation regression: 4/4 PASS.
- Full focused C14-A/B/C regression set: 67/67 PASS.
- Typecheck: PASS.
- Invariants: 42/42 PASS.
- Build: PASS.
- `git diff --check`: PASS.
- Full suite: UNKNOWN; not rerun because of the known slow nonce-cache test.
- Hosted CI: UNKNOWN until the pushed commits are inspected.

The confirmation raw artifact and this report are new files. The previous C14-E raw reports and partial report remain unchanged.

This is source-only evidence. It does not prove installed-runtime behavior, physical chaos, connector interruption, Big Mac behavior, public exposure, or human acceptance. C13 remains NOT PASS and E7 remains BLOCKED — HOST CAPABILITY.

