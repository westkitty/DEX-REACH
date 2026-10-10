# C14 scheduler and durable admission repair — 2026-10-10

Source campaign on `c14-chaos-recovery`, starting at
`b676d5561382074c401dbaef07f90837b7f9948c`, for draft [PR #16](https://github.com/westkitty/DEX-REACH/pull/16).
The two capacity/coordinator edits and the untracked capacity-fairness test present at authorization
were preserved and integrated. This record supersedes the prevention limitations in the earlier
CodeQL resource-exhaustion receipt for future source behavior; it does not rewrite historical evidence.

## Classification and admission

Executable/leading-script identity replaces arbitrary argument matching. The service parser follows
Node loader value flags and the known tsx launcher to the actual service entrypoint; eval strings,
loader values and later arguments cannot establish an exclusion. Idle resident agents and
desktop applications do not consume a substantive slot merely for memory residency. Active desktop
helpers group with their app; agent/tool descendants group with their workload ancestor; independent
sessions remain separate. Active unknown executables still compete. Helper flags and service-path
arguments cannot exempt a compiler. Host pressure is evaluated independently of these identities.

The 8 GiB MacBook retains one substantive slot. Slot ceilings, FIFO tickets, repository locks,
lease ownership and degraded-state refusal remain. Unreadable process observations refuse substantive
admission and cannot establish sustained health. Lease exclusions require process-start evidence;
reused/unknown PID identity is conservatively counted. Production samples must be at most two seconds
old and match the admission-time lease set. Unknown memory/CPU pressure, saturated CPU and thermal
limiting now also refuse medium substantive work; this closes a safety gap previously limited to heavy
work. Warning memory/busy CPU remain heavy-only restrictions; unavailable thermal sensors remain
explicitly unknown. macOS probes run concurrently with bounded one-second command timeouts.

## Deadline and durable-state contract

The default gateway response budget remains 60 seconds. A validated additive wire duration gives
synchronous node admission half that budget, capped at 30 seconds, starting at socket ingress using
a monotonic clock. Historical gateways receive the 30-second ceiling. Polling is bounded to 250 ms.
No timer races away an acquisition promise: a lease arriving after deadline is released before any
execution, and cleanup failure is visible. A stalled coordinator call or persistence can still outlast
a very short transport deadline. A transport timeout never establishes nonexecution or cancellation.

Durable starts persist ACCEPTED/PREPARING and return the original handle before capacity waiting.
Queue continuation has its own 30-second admission budget. Same-key attachment preserves identity,
including acknowledgement loss and restart. Capacity waiting consumes no grant use or concurrency
budget; reservation and owner-policy revalidation occur once immediately before RUNNING. Owner OFF,
changed policy, exhausted grants and wrong actor/node still refuse. Existing consumed-grant policy
hash and authorization constraints can prevent reattachment/result retrieval; recovery then needs
renewed owner authority. This campaign does not relax that boundary or authorize a new effect.

Unstarted ACCEPTED failures legally end CANCELLED; PREPARING failures end FAILED with their refusal
classification persisted in the same snapshot update. Possible mutating execution remains AMBIGUOUS
when result persistence fails. A completed, task-bound result remains COMPLETED if a later receipt
write fails. Cancellation cannot advance a cancelled task into execution and targets only that task's
attempt ticket. Restart never automatically replays pending or ambiguous work.

## Bounded evidence and compatibility

The existing `tasks/events.jsonl` family remains; there is no installed migration or new live family.
Retention reserves up to 1,500 causal lifecycle/refusal/result-binding entries, fills remaining space
with recent detail, and caps the journal at 2,000 entries and 2 MiB. More than 1,500 decisive events
can still evict old evidence. Retained IDs and order survive; `historyGap` and missing cursors disclose
loss. No absent historical event is reconstructed. Result references and sanitized failure classes
remain content-free. Malformed records or duplicate event IDs make appends/strict replay fail visibly
without replacing the original journal. Historical corruption therefore requires owner reconciliation,
not automatic scrubbing. Public Server-Sent Events retain the existing fixed lifecycle projection.

## Reproductions and integration evidence

Failing regressions covered misleading service/helper arguments, unknown demanding workloads,
causal-event eviction, oversized/duplicate historical events, stale/changed-lease samples, pressure
fallbacks, deadline hierarchy and legal pre-execution failures. A one-use grant regression exposed
premature consumption and verified its repair without allowing exhausted-grant execution.

The real gateway registry, node subprocess, coordinator Unix protocol/persistence and native effect
oracle were exercised in isolated synthetic roots. Coverage includes idle desktop, genuine sibling,
full slot, admission timeout, stalled acquisition beyond response timeout, queued acknowledgement,
wrong actor/node, critical pressure with light reads, lost acknowledgement, disconnect after RUNNING,
lost response after actual effect, result/receipt persistence faults, cancellation, completed/queued/
active restarts, original result retrieval and refusal of duplicate ambiguous effects. The OAuth/MCP
stream fixture uses explicitly synthetic sensors; other proof harness callers default to physical
sampling. Synthetic fixtures never constitute installed or physical-host acceptance.

## Matched measurements

Final same-host source comparison after validation finished against an exported starting revision, Node v26.11.0; isolated state,
2,000 process rows/events, cached status, ticket enqueue/cancel and 256 real WebSocket pending requests.
These are distributions/medians for this workload, not universal latency or peak-memory guarantees.

| Operation | Before | Candidate |
| --- | ---: | ---: |
| Classify 2,000 rows | 3.736 ms | 4.990 ms |
| Admission decision | 0.181 us | 0.185 us |
| Cached status | 9.990 ms | 9.656 ms |
| Physical host sample | 34.031 ms | 34.929 ms |
| Ticket enqueue/cancel | 33.709 ms | 32.961 ms |
| Append to 2,000-event journal | 11.831 ms | 14.861 ms |
| Dispatch 256 pending requests | 25.645 ms | 20.234 ms |
| Settle 256 pending requests | 13.580 ms | 10.984 ms |

Both pending maps returned to zero. A 10,000-event input retained 2,000 entries: 294,061 versus
294,319 serialized bytes. Journal disk size was 294,120 versus 294,138 bytes. Pending heap/RSS deltas
were 580,152/360,448 versus 414,160/49,088 bytes for one batch, not peak bounds. Long-session heap
deltas were negative under garbage collection and cannot establish an allocation improvement.
Before the tsx correction, a quiet sample measured classification 3.738/3.946 ms and journal append
11.135/12.813 ms. The final parser and retention incur measured costs; there is no latency-budget claim.
An earlier concurrent sample showed approximately 10 versus 20 ms journal appends; there is no claim
of a consistent retention speedup. Structural entry/byte limits, rather than garbage-collection noise,
establish bounded retained evidence. A separate run concurrent with full validation recorded before/candidate classification 4.177/5.700 ms,
admission 0.198/0.422 us, cached status 9.695/40.014 ms, sampling 51.980/88.229 ms,
ticket handling 29.162/122.910 ms, journal append 12.359/41.438 ms, dispatch 66.803/20.055 ms
and settlement 61.848/10.272 ms. It demonstrates scheduling noise, not an isolated candidate regression
or improvement. No installed profiling was performed.

## Validation and publication

Final `npm run verify` exited 0: typecheck, 42/42 invariants, 665/665 tests (zero failures,
cancellations or skips), build, audit at the unchanged high threshold (six moderate advisories), and
26-tool backend probe. `git diff --check` passed. The preceding focused corrections passed 12/12
integration/authority tests, 10/10 retention/authority tests, and the final actual-process fault fixture
passed 1/1. Hosted results remain pending publication/readback. Full verification
initially found an existing authority test that expected appending through corruption; the authority
proof remains, and the journal contract now explicitly verifies fail-closed preservation. Independent
read-only review found the duplicate-ID retention loophole; its failing regression and fix are included.
A broader run exposed background status sampling consuming a shared fault-injection delay; the
fixture now binds that delay to acquisition so the timeout assertion is deterministic. No failed run
is promoted to PASS. A loaded run also refused admission before reaching a result-write fault;
persistence fault tests now wait for preceding lease release and use a ten-second transport budget,
while the dedicated two-second admission/refusal assertions remain unchanged. Requested `CONSTITUTION.md` and `BOUNDARY_MAP.md` were not present
in this checkout; existing operational state, architecture, canonical state machine and invariants
were used. Exact published head and five hosted checks must be read back independently.

## Installed and historical boundaries

Read-only owner metadata inspection observed 19 nonterminal records: 17 PREPARING and 2 RUNNING.
Four surviving event windows show accepted/waiting pre-execution timeout signatures; 14 original
windows are absent; zero task-bound result references establish completion. The historical classes
remain 17 AMBIGUOUS_EFFECT and 2 INSUFFICIENT_EVIDENCE. Neither a missing RUNNING event nor an
unbound receipt proves historical nonexecution. All records remain untouched; replay is unauthorized.

No installed runtime, service, LaunchAgent, live coordinator lease, task/result, policy, credential,
backup, connector, deployment or release mutation occurred. No PR merge occurred. C13 NOT PASS;
E7 HOST CAPABILITY BLOCKED; C14 PROGRAM PARTIAL pending separately authorized installed acceptance;
C15 BLOCKED. Installation and fresh exact-node runtime acceptance remain owner actions.


## Hosted corrective pass

Source commit `388f3bebd856af15160353191a1e03753f3a5247` was pushed with exact remote parity.
Hosted validate, analyze, reproducible-build and CodeQL succeeded; runtime-proof failed the typed
workspace-safe write with one observed competing workload. This failure remains historical.
An isolated actual process-table probe reproduced tsx service launch shapes containing Node
`--require`/`--import` loaders and the tsx CLI wrapper. The previous service parser missed both;
a new regression failed before correcting actual-entrypoint parsing. The exact process counted by
the failed hosted run was not retained, so its identity is inferred, not independently established.
No sensor bypass or slot/pressure relaxation was used for this correction.

A subsequent focused batch passed 38/39 but timed out waiting for an active-task restart to reconnect;
its child output was previously discarded, so the exact cause is unverified. The fixture now retains
bounded child diagnostics and detects an exited node immediately. The isolated restart rerun passed
1/1. This does not erase the failed batch or establish that every scheduling condition is proven.
The corrected exact-source comprehensive and hosted results are recorded after completion below.


The corrected candidate passed final `npm run verify` with 665/665 tests, 42 invariants, typecheck,
build, the unchanged high-threshold audit (six moderate advisories), 26-tool probe and whitespace
checks. Independent targeted read-only review found no blocker in the actual-entrypoint correction.
Publication and exact-head hosted readback remain separate gates.
