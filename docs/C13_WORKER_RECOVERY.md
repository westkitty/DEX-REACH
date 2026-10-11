# C13 worker and queue recovery

Status: installed fingerprint repair and E4 PASS; related queue cleanup repair is source-only. C13 remains NOT PASS.

## Fingerprint transport repair

The worker client used a 5,000 ms IPC deadline while fingerprinting could perform four sequential native captures, each bounded at 4,000 ms. A live response arrived after 5,362 ms, confirming that the old client deadline could reject a successful worker response. The original ChatGPT failure's precise cause remains unproven.

The repair shares the capture bounds from `fingerprint.ts` and gives only `dex.fingerprint` a 21,000 ms transport deadline: four capture limits plus the existing 5,000 ms IPC allowance. Other delegated operations keep their 5,000 ms deadline. The delayed-response regression requires a fingerprint reply after 5,500 ms to succeed and an ordinary file-read request to time out at its unchanged deadline. No worker operation, policy, root, credential, or execution authority was added.

This fingerprint repair was installed in immutable release `0.3.2-175d58b8cce5-2f44ae46b11b-dirty-1791501412637`. Owner-local verification reported coordinator, worker, gateway, and node running. Actual ChatGPT durable fingerprint task `rtsk_1a11dd2033f_bafe187416836f1b920ed7d2d4f9fc79` completed once and its same-ID result was retrieved. Direct `reach_fingerprint` also succeeded. The original failed task remains preserved. See [real-host E4 proof](C13_E4_REAL_HOST_PROOF_20261008.md).

## Related orphan-ticket repair (source-only)

An earlier owner-local inspection found one queue ticket whose PID equaled the coordinator daemon PID; its heartbeat was written after the linked task had failed. Source review confirmed why stale pruning could not retire that ticket after a requester exit: routed `coordinatedAcquire` omitted the requester PID, `acquireWork` defaulted to the daemon's PID, and stale-ticket pruning requires that PID to be absent. Because the daemon stays alive, this orphan ticket could remain indefinitely.

The repair binds the caller PID in the coordinator request and explicitly records `pidIsWorkload: false` unless a caller supplied an actual workload PID. Ticket cancellation remains scoped to the exact caller ticket. This changes neither durable task state nor replay decisions. Focused tests cover caller/workload PID separation and persisted ticket identity. The source repair has not been installed; its effect on the running coordinator is unverified.

The historical ticket was cancelled using the supported owner-local CLI after its linked task was already terminal. No task record was edited, replayed, or rewritten. Historical `PREPARING` and `RUNNING` records with `AMBIGUOUS_EFFECT` remain preserved; their uncertain external effects are not inferred away.

## Campaign state

- E3: PASS for the reviewed fixture/freshness correction published to owner-only Site version 2. The Site remains a static snapshot, with no live refresh or execution authority.
- E4: PASS for the installed real-host read-only fingerprint flow and same-task result retrieval.
- E5: accepted `UNDECIDABLE-FROM-LOGS`; E6 remains PASS on its recorded scope.
- E7: PARTIAL. No actual connector disable/re-enable interval has been completed while the same durable task was RUNNING.
- C13: NOT PASS. C14 remains preparation-only; C15 has not started.

Source commit, push, and CI are recorded separately from installation and runtime proof. Do not use this source-only queue repair as evidence that the installed coordinator changed.
