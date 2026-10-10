# C14 Protocol v2 completion campaign

Date: 2026-10-10. Authority: source-only maximum-scope campaign on
`c14-chaos-recovery`, PR [#16](https://github.com/westkitty/DEX-REACH/pull/16),
base `c13-worker-repair`. Starting source was
`257138213f24cf2eaa97d5426bbd73442d025f7c`. Tested production candidate is
`f4efc91643a71a3b163665df072f3832322a855f`; the subsequent activity fixture and report commits are
bookkeeping and do not replace the measured source identity.

## Verdicts and measured scope

| Verdict | State | Scope |
| --- | --- | --- |
| Cross-project integrity | CLEAN | Existing bounded audit plus campaign file inventory; unrelated projects not opened or changed |
| Response provenance | PASS | Real enrolled WebSocket peers: wrong node, stale socket, duplicate/out-of-order response, disconnect, revocation, shutdown |
| Negotiation | PASS | Validated offer/ack state machine, semantic versions, malformed/empty/duplicate offers, unoffered caps, one ack, legacy no-ack sealing, reconnect reset |
| End-to-end streaming | PASS | Real OAuth client, gateway, exact node, persisted task, accepted/terminal SSE delivery, cursor replay after node/gateway restart |
| Durable execution | PASS | Persisted admission, same-key reattachment, original actor/node/payload/policy authority, verified results, cancellation uncertainty, one independent external effect |
| Historical interoperability | PASS | Actual compiled historical/current A–F combinations and historical/historical control; bearer, Ed25519, reconnect and no fallback |
| Security/privacy | PASS | Changed-path/expired-grant negatives, actor separation, normalized timestamps, fixed lifecycle projection, bounded subscribers, credential mutation race |
| Performance/lifecycle | PARTIAL | Bounded store baseline/repeat and 64 real SSE replays; no latency budget or installed/descriptor/long-session streaming profile |
| C14 source | PASS | Authorized source acceptance contract, measured repository scope; supplemental unmeasured cases below remain explicit |
| C14 program | PARTIAL / NOT COMPLETE | Installed migration, connector, physical, ecosystem and human acceptance remain independent |
| C15 readiness | BLOCKED | C14 program and retained C13/E7 gates have not closed |

PASS does not mean every possible product, historical consumer or failure schedule
was exercised. The source campaign's 25 acceptance conditions concern current
source behavior and its protected boundaries. Performance without a budget is
reported as a distribution, not promoted to a performance PASS.

## Demonstrated defects and repairs

- A different authenticated node could answer another node's pending request.
  Pending work now binds both enrolled node ID and the current socket. Replacement,
  disconnect, revocation and shutdown invalidate pending work. A first valid
  response claims the pending slot before asynchronous credential verification;
  later duplicates cannot win that race. Malformed responses cannot claim it.
- Task controls could lose the original operation's path/capability constraints.
  Records persist a minimal authority projection; every control/replay checks the
  original actor, node and current owner grants against it. Legacy records without
  that projection require unchanged policy and no inferred grants.
- Cancellation could label a running external effect CANCELLED. Remote cancel now
  refuses RUNNING/AMBIGUOUS with `CANCELLATION_UNPROVEN`; pre-execution cancellation
  uses an atomic state guard. Terminal records remain authoritative.
- Concurrent durable starts could create duplicate work. Admission is serialized
  in isolated node state and duplicate keys reattach. A bounded admission timeout
  returns uncertainty, never a fabricated handle; retry must use the original key.
- Parseable timestamp comments could leak private text. SSE timestamps are
  normalized to ISO; arbitrary summaries and other node-supplied fields are not
  forwarded. Lifecycle kinds are restricted to five fixed identifiers.
- Corrupt/missing lifecycle history could be interpreted as current progress.
  Streaming refuses corrupt history or missing event states. Missing/truncated
  cursors produce a gap; the task snapshot is not substituted for lost events.
- Credential refresh could overwrite enrollment while persistence awaited I/O.
  Native proof failed with enrollment mode `bearer`; a controlled persistence
  regression reproduced it. Async credential readers/writers now share a local
  serial queue while mutations retain the cross-process lock. The repaired proof
  and deterministic regression passed.

`task_reconciliation` is no longer advertised remotely: reconciliation remains
an owner CLI operation. `durable_tasks`, `task_event_stream` and `two_phase_plan`
retain usable, tested paths. V2 synchronous operations already persist an internal
record; synchronous public schemas and result envelopes remain unchanged.

## Public stream contract and actual client

The additive source route is:

`GET /api/v2/tasks/:taskId/events?node_id=<exact-enrolled-node>`

Use the same OAuth bearer authorization as `/mcp`. Resume with `Last-Event-ID:
tev_<24 hex characters>`. HTTP 400 rejects malformed identities/cursors, 401
rejects missing authentication, 403 hides unavailable/unauthorized task details,
and 429 bounds subscribers. After headers, loss of authority closes the stream;
reconnection must authenticate again. This endpoint has not been deployed.

Each `event: task` frame contains task/node identity, stable event ID, normalized
UTC time, lifecycle kind/state and fixed status text. `event: gap` explicitly
means retained history cannot establish the requested cursor. Actor ownership is
an authorization binding, not a public actor identifier. Append order is
canonical; timestamps are not a distributed ordering clock. Duplicate delivery
across uncertain reconnects remains possible: consumers retain the last completely
received event ID and deduplicate it. The example client exposes gaps to its
caller and updates its cursor only after delivery.

Node-owned persisted history supplies replay; unsolicited `task_event` hints are
not the authoritative public stream. Gateway/node restart does not reconstruct
progress from an in-memory push buffer. Terminal closure requires matching
persisted terminal history, not merely a terminal snapshot.

Limits: 32 subscribers per gateway; one outstanding node read per subscriber;
100 events per page; 2,000 retained log events; 5-second read timeout; 250-ms poll;
60-second polling deadline checked between pages and 60-second socket idle
timeout; 2-second writable-drain deadline per blocked frame. An already-authorized
read/page may finish beyond the polling deadline; this is not a hard 60-second
connection-lifetime claim. A blocked write
stops additional frame writes and reads, then resumes on drain or closes on
expiry/disconnect. Revocation is checked before each page; an already-authorized
page may finish. Tests instrument `write(false)`/drain and verify release of all
32 subscriber slots. They do not claim actual kernel saturation or measured
file-descriptor growth.

Run the actual source interface demonstration with
`npx tsx scripts/c14-event-client.ts --fixture`. Integration tests prove accepted
and completed delivery; client disconnect; node restart/cursor replay; gateway
restart while an external process waits; expired cursor/gap; other actor/OFF
refusal; and exactly one external `effect` in a separate oracle file. No external
process is released until RUNNING, cancellation refusal and reconnection have
been observed. Under full-suite contention, admission uncertainty is reconciled
only with the identical key.

The installed MCP SDK uses JSON responses on the existing endpoint. Its current
transport and draft tasks-extension contracts were inspected before choosing
this versioned SSE route; no unsupported SDK methods or new MCP tool were added.
See the official [Streamable HTTP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)
and [draft tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks).
There is no invented legacy REST task API or new connector OpenAPI document.
The six-month dual-stack window starts at future v2 general release, not at this
source campaign. Protocol v1 removal still requires explicit governance.

## Real historical interoperability

Historical revision: `5b08354ace35644a2ff9e72e346ff745484eb8ca`, genuine repository
history predating semantic v2 and remote durable-task admission. Its own manifest,
lockfile, dependency installation and TypeScript build produced its own `dist`.
Current/historical gateway and node are separate compiled JavaScript processes,
with synthetic credentials, real OAuth MCP, dynamic IPv4 loopback ports and
separate disposable state. Enrollment CLI/harness comes from current source;
there is no installed historical release involvement.

| ADR cell | Compiled pairing / requested operation | Result |
| --- | --- | --- |
| A | Current gateway/current node, durable file read | PASS, durable `rtsk_` handle |
| B | Current/current synchronous read | PASS |
| C | Current gateway/historical node, durable | Explicit `CAPABILITY_UNSUPPORTED_ON_NODE`, no handle |
| D | Current/historical synchronous read | PASS |
| E | Historical gateway/current node synchronous read | PASS |
| F | Historical/current durable | Historical ingress rejects unknown `reach_task` (-32602), no handle |
| G | Historical/historical synchronous control | PASS |
| K / N | Every pairing: Ed25519 proof, reconnect, missing-node refusal | PASS |

See [allowlisted actual results](C14_V2_HISTORICAL_RESULTS.json) and
`scripts/c14-historical.ts`. Each pairing also begins with bearer authentication,
reconnects, and shuts down/cleans its test-owned resources. Current negotiation
fixtures additionally prove capability replacement and no fallback. This is not
an exhaustive matrix of every old public client, wrong actor across every old
version, or an installed in-place upgrade. Historical dependencies have their
own legacy advisories; they were not installed into production.

## Validation and independent review

Production candidate checks are recorded in the validation supplement below.
Native proof: 20 proven, 0 failed, 2 unverified; fresh-node installation and a
second physical machine remain unproven. Its Android item was an existing
read-only identity probe, not deployment or new physical v2 acceptance.
Clean rebuild: 172 artifacts, byte-for-byte at `f4efc91643a7`, no differences.

Independent adversarial subagent review reproduced authority and timestamp
leaks, identified the cancellation and lock-contention hazards, and rechecked
bounded fixes. Final changed-scope review found no unresolved source blocker;
node-auth 4/4 and stream-boundary 2/2 passed. This is source review, not independent
installed evaluation or human acceptance.

Preserved failures: hosted validation `38037603905` at `d498a4e` failed because
an expanded enrolled-node fixture tried to reenroll an existing node; corrected
in `2b38575`. Local pre-final full run was 394/395: bounded admission uncertainty
was incorrectly assumed to always return a handle. The recovery fixture now
reconciles the original key and retains same-ID/one-effect assertions. Initial
native proof was 19/1/2; the deterministic credential race failed before repair.
The f4efc91 local full run additionally failed an existing 350-ms activity fixture (396/397): its child exited between two reads. Commit 0ea344a holds that child until running activity is observed, retaining real PID, running-state, completion and exit assertions; focused activity tests passed 8/8. These results are retained, not relabeled green.

## Supplemental boundaries and continuation

Broad packet coverage reuses existing task/result/boot-recovery, coordinator,
worker, OAuth, policy, trace, receipt, catalog and immutable-install source tests.
See [C14-H](../c14-chaos/C14_H_MATRIX.md) for their exact seams; a store-level
restart test is not a child-process crash or installed interruption.

| Requirement beyond measured core | Classification | Exact remaining evidence / authority |
| --- | --- | --- |
| Real kernel-slow consumer and drain-timeout resource curve | INSUFFICIENT_EVIDENCE | Additional isolated socket-saturation/descriptor measurement; existing application pause test passes |
| Every durable failure phase with dedicated node/worker process kill | INSUFFICIENT_EVIDENCE | Existing worker restart/boot/coordinator fixtures plus current gateway-loss oracle are narrower than an exhaustive phase matrix |
| Task expiration versus unknown | NOT_APPLICABLE to advertised lifetime contract | No remote task TTL is advertised; owner retention/archive policy exists. A public expiry/tombstone policy needs an owner architecture decision before adding semantics |
| Remote task reconciliation | NOT_APPLICABLE to advertised capabilities | Removed capability; governed owner CLI remains. Exposing it remotely requires an architecture/authority decision |
| Installed idle cost and physical mixed-version migration | EXTERNAL_GATE | Authorized maintenance, exact installed proof and rollback readiness |
| Connector survival and human visual/functional acceptance | EXTERNAL_GATE | Owning client/host controls and explicit authority; E7 host capability remains blocked |
| DEX ecosystem integration | EXTERNAL_GATE | Authorized authoritative DEX/PAIR/DROPZONE/WITNESS consumer evidence; unrelated source is protected |

Three highest-impact gates:

1. Installed migration/acceptance: only under an explicit maintenance window,
   after release-SHA/version and rollback readiness are approved. Source output
   does not prove this installed candidate.
2. Real connector survival: obtain a supported owning-host interruption mechanism
   and prove the same running durable task; current E7 is HOST CAPABILITY BLOCKED.
3. Ecosystem/human acceptance and public lifetime/reconciliation decisions:
   obtain owner architecture authority where needed, then exercise actual clients.

Safe optional extension is isolated slow-socket/descriptor and remaining process
phase fixtures. It is not a reason to rerun completed scans or the historical
11-minute stress campaign. Continue from this report and existing C14-H/J owners,
not a new general resume procedure. For source regressions use `npm run verify`,
`npm run verify:clean-build`, the historical script with a disposable old checkout,
and the event client fixture. No installer command is part of this continuation.

## Protected state and publication

All campaign mutations are in the authorized repair worktree and its C14 branch.
PR #16 stays draft/open/unmerged with base `c13-worker-repair`. No merge, tag,
installation, release switch, launchd operation, owner credential/policy change,
connector refresh, Big Mac operation, DEX or Gay Cast mutation was performed.
Synthetic enrollment/revocation and process signals apply only to test-owned
fixtures. Main and PR #15 were not changed by this campaign. This is an action
inventory, not a new checksum certification of unread protected owner state.

Retained installed C13 identity comes from authoritative historical operational
metadata: `0.3.2-87a99494ebb3-2f44ae46b11b`. No fresh installed verification was
performed. C13 remains NOT PASS; E7 HOST CAPABILITY BLOCKED; C14 program PARTIAL;
C15 BLOCKED. No source verdict overrides those gates.

## Bounded performance observations

Matched sequential runs used the same MacBook arm64/Node 26.11.0, benchmark
implementation, warmup 3, samples 15, fixture sizes and temporary state. Before
source is `2571382`; after checkout is `0ea344a` (production modules equal
`f4efc91`). No full-suite or historical process workload overlapped either run.
The configured after SHA label is retained alongside the actual checkout SHA
in [after metrics](../c14-performance/C14_V2_AFTER.json).

| Isolated store operation | Before p50 / p95 ms | After p50 / p95 ms |
| --- | --- | --- |
| Durable record creation (not network acknowledgement) | 21.86 / 24.97 | 19.90 / 25.19 |
| Indexed lookup, 128-record fixture | 1.97 / 2.50 | 1.94 / 2.41 |
| Create, 128-record fixture | 29.61 / 48.90 | 28.04 / 34.91 |
| Event append, 512-event fixture | 12.08 / 20.01 | 11.09 / 12.73 |
| Coordinator acquire + release | 28.94 / 34.02 | 34.00 / 46.44 |

Coordinator tail increased in this sample. Its implementation did not change;
15-sample p95 is effectively the maximum. This is an observed difference, not
proof of an attributable code defect or of acceptable latency. No optimization
or invented budget was used to make it green. The other raw result/queue/release/
pagination measurements remain in [before](../c14-performance/C14_V2_BEFORE.json)
and [after](../c14-performance/C14_V2_AFTER.json). Harness RSS delta was 71,030,656
before and 53,659,456 bytes after; neither is installed-service cost or leak proof.

[Actual SSE workload](../c14-performance/C14_V2_STREAM.json): 64 complete replays,
concurrency 8, one OAuth durable task; p50 4.95 ms, p95 262.30 ms, p99 262.46 ms;
92,160 response bytes; harness RSS delta 3,017,024 bytes. The first batch includes
completion polling while the task runs; later batches replay terminal history.
The 250-ms poll explains that initial delivery tail. This is not a warmed
per-event latency or reconnection-delay benchmark. No prior SSE route existed
at the starting revision, so no fabricated before/after SSE speedup is claimed.
The production example also delivered ACCEPTED, PREPARING, RUNNING and COMPLETED.

No project latency budget exists for these paths. Descriptor growth, separate
v1/v2 handshake latency, installed idle use, and sustained new-stream churn are
not measured. Application pending/subscriber caps, disconnect cleanup, policy
checks, log retention and replay pagination are tested; those tests do not turn
unmeasured lifecycle rows into PASS.

## Validation supplement and Git receipt

| Check | Actual result / identity |
| --- | --- |
| Full local `npm run verify` | PASS on source/test candidate `0ea344aa216c2d4dfdcf329f1373519e05b96f6a`: 397 tests, 397 passed, zero failed/skipped/cancelled |
| Typecheck / invariant manifest / build | PASS; 42 release-blocking invariants; current dist rebuilt |
| Production audit | PASS at high threshold, six moderate advisories remain; no dependency or lockfile change |
| Backend probe | PASS, 26 compatibility tools |
| Focused changed protocol/authority/security fixtures | 29/29 pre-final set; expanded actual stream integration 2/2; final boundary 2/2; auth/provenance 5/5; activity repair 8/8 |
| Native `proof -- --require-live` | 20 proven / 0 failed / 2 unverified on production f4efc91; no installation proof |
| Local clean rebuild | 172 artifacts byte-for-byte at production `f4efc91`; final publication rebuild is separately checked after report commit |
| Compiled historical integration | Four pairings on f4efc91, all primary ADR cells and signed transport checks successful |
| Actual example client | ACCEPTED through COMPLETED using source/test candidate 0ea344a |
| Hosted DEX validation | [38039688988](https://github.com/westkitty/DEX-REACH/actions/runs/38039688988), completed success associated with PR head `0ea344a`: validate, runtime-proof, reproducible-build all PASS |
| CodeQL workflow | [38039688967](https://github.com/westkitty/DEX-REACH/actions/runs/38039688967), completed success associated with PR head `0ea344a` |
| Diff hygiene | PASS before report publication |

Hosted revision distinction: validation checked synthetic merge
`a004485307f8d439b25e007a67fec27d6fd24ea7`, merging source head `0ea344a` into base
`391d0b0024b0db8e8da473e5a683a92d190bdb13`. Runtime-proof and reproducible-build
explicitly checked out PR source head. A workflow's headSha is not by itself
proof that every job checked out that SHA. Report-publication CI is observed on
the final bookkeeping head separately; latest owning results are visible on
[PR16 checks](https://github.com/westkitty/DEX-REACH/pull/16/checks).

Campaign commits before documentation:

- `d498a4e`: authenticated current-connection provenance repair.
- `2b38575`: actual bounded replay, admission, negotiation and task authority.
- `44e980a`: corrupt-history refusal.
- `18406f1`: same-key admission reconciliation and explicit effect gate.
- `02368b2`: allowlisted lifecycle kinds and flow-control fixture.
- `f4efc91`: credential refresh/enrollment serialization and deterministic race.
- `0ea344a`: test-owned activity child held until live observation.

Final documentation/metric inventory and publication SHA are available through
Git/PR16; the report does not claim to contain its own commit hash. Source and
test candidates were normally pushed with remote readback; the final publication
receipt separately verifies clean worktree, exact remote parity and unchanged
PR draft/base state. No duplicate PR was created. Historical evidence remains
in place beneath current-state notes rather than being rewritten as current.
