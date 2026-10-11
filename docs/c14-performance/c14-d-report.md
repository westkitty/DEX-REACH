# C14-D performance report

## Status

- C14-D baseline: PASS at isolated source scope.
- C14-D matched final: PASS as a baseline/repeatability check.
- No production optimization was justified by the matched measurements. Production behavior was unchanged.

The baseline was captured from `fada83b85ce60aa64f81bc5314148d0c683737d0`. The matched repeat was captured from `f0bc40b43059e7bdd00de344d0f89f1fe27f023d`, which only adds the harness and report wiring.

Raw artifacts:

- [baseline JSON](c14-d-baseline-fada83b.json)
- [matched final JSON](c14-d-final-f0bc40b.json)
- Harness: `scripts/c14-performance.ts`, invoked with `npm run benchmark:c14 -- <output>`

## Conditions

Node `v26.11.0`, Darwin arm64, 15 measured iterations after 3 warmups per operation. Timing uses monotonic `performance.now()` and reports median/p95 in milliseconds. Fixtures use temporary `DEX_REACH_STATE_DIR` directories, synthetic records only, bounded sizes, and deterministic cleanup. No credentials, owner task records, installed services, or real task payloads were accessed.

## Matched observations

| Category | Baseline median / p95 | Final median / p95 | Interpretation |
| --- | ---: | ---: | --- |
| Durable task acknowledgement | 18.35 / 31.36 ms | 18.79 / 22.34 ms | Repeatable within run-to-run noise; no optimization claim |
| Task create at 128 records | 28.33 / 30.92 ms | 24.91 / 28.05 ms | Durable rewrite cost is visible; bounded fixture only |
| Indexed task read at 128 records | 1.98 / 4.40 ms | 1.53 / 1.75 ms | Indexed lookup remains low at this size |
| Task list at 128 records | 1.82 / 2.75 ms | 1.40 / 1.55 ms | No obvious scaling defect in bounded range |
| Event append with 512 existing events | 11.40 / 52.80 ms | 10.50 / 11.13 ms | High baseline p95 was not reproduced; treat as noisy |
| Result write, 64 KiB payload | 22.72 / 48.13 ms | 20.76 / 42.89 ms | File/manifest write dominates; no source change made |
| Result read, 64 KiB payload | 0.21 / 1.40 ms | 0.36 / 1.25 ms | Low absolute cost in isolated state |
| Coordinator acquire and release | 37.80 / 93.44 ms | 34.07 / 36.35 ms | Highest measured path; variance prevents improvement claim |
| Queued admission and cancellation | 34.97 / 55.41 ms | 36.04 / 48.93 ms | Queue behavior remained bounded |
| Bounded event page, 25 items | 0.66 / 0.98 ms | 0.63 / 0.86 ms | Response remained bounded at 4,312 bytes in baseline |

Task-store fixtures covered 16, 64, and 128 records. Event fixtures covered 0, 64, 256, and 512 pre-existing events. Result fixtures covered 256 bytes, 4 KiB, and 64 KiB payloads. The harness-process RSS delta was 49,042,880 bytes in the baseline and 59,170,240 bytes in the repeat; this is not installed-service idle cost and is not treated as a regression verdict.

## Unmeasured surfaces and boundaries

- Dashboard delta refresh: NOT MEASURED. No callable production implementation was found.
- Idle installed-service CPU/memory cost: NOT MEASURED.
- Long-session stress: deferred to the next packet.
- These are source-only isolated measurements, not installed-runtime, physical-device, connector, or human-acceptance proof.
