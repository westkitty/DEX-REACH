# Bounded performance evidence

Measured on 2026-10-02 against reviewed base `3345b055a0d088869403443c219406590b9fb501` (version 0.3.2), using isolated baseline and candidate checkouts on the same Mac. Source and isolated MCP acceptance passed. Installed ChatGPT/Claude experience remains UNVERIFIED / NOT COMPLETE for that scope. No installation was attempted.

## Changes and measurements

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Populated discovery fixture, serialized UTF-8 JSON bytes | 3,032 | 951 |
| Host samples for five repeated warning / critical / unknown status requests | 5 each | 1 each |
| Routed file-read median, 30 samples per version | 11.543 ms | 5.244 ms |
| Observed 95th percentile | 20.653 ms | 7.291 ms |
| Discovery/fingerprint/read workflow calls | 37 | 37 |

Discovery defaults to compact scheduler history, with explicit `eventsOmitted:true`; `detail:true` retains privacy-redacted events. Existing fields, cursors, null/unknown semantics, the registry snapshot and WebSocket publication remain unchanged.

Status caches host observations for the existing two-second lifetime using monotonic expiry and concurrent-sampling coalescing. Actual injected sampler invocation counts were measured against the baseline handler and candidate seam; the candidate sequences finished in approximately 8–13 ms. Leases, capacity and queue state are recomputed on every request. Admission always obtains a new sample after the request begins; warning admission after cached healthy status remained queued. Invalidation fences older in-flight status results.

Request tracing queues sanitized spans with frozen destinations, 1,024-span / 512-KiB bounds including in-flight memory, 64-span writer batches and flushing scheduled within 100 ms. Overflow drops newest diagnostics; filesystem failures count lost spans without retrying or rejecting requests. Awaited `recordSpan`, cross-process file locks, JSON Lines, permissions and 500-span retention remain. Diagnostic reads and shutdown attempt captured-watermark flushing capped at two seconds, with a local incomplete indication. Queued evidence may be lost on crash or forced termination. Authorization, audits, signed receipts and budget release remain awaited and authoritative.

Selection guidance prescribes at most 60 seconds of explicit-node reuse by client elapsed time, with rediscovery on reset, target/repository change, continuity loss, revocation, observed identity/access/capability change, expiry or unknown freshness. Required trust reports and fresh plan/commit fingerprints remain required. The baseline already reused its selection, so this workflow saved zero calls; automatic client adoption and model-time savings are not claimed.

## Isolated action and timing proof

Used existing `scripts/lib/live-reach.ts`: real gateway/node processes, OAuth-authorized MCP client, Streamable HTTP transport, unique explicit test node, loopback ephemeral ports and temporary isolated state/worker/coordinator namespaces. The normal bootstrap/test coordination path remained active. Disposable credentials/state were removed after proof processes stopped; production services and authority were untouched.

Both versions used the same 2,496-byte UTF-8 fixture, `reach_file_read`, `max_bytes:4096`, development node profile and isolated owner read-only policy. Initialization was excluded; five warmups preceded 30 measured calls per version in alternating five-call batches, reversing starting version each round. Each observation used client `performance.now()`. [Raw samples and schedule](PERFORMANCE_TIMING.json) include median and nearest-rank observed 95th percentile. Both improved; the regression-repeat condition was not triggered. This sample does not establish a reliable 99th percentile.

A separate real MCP proof injected two writers that entered and remained blocked with no release path. A bounded read returned useful content and `_meta['dex-reach/trace-id']` with zero persisted trace files. Holding its signed-receipt lock prevented response completion after the node audit appeared; releasing the lock allowed success while both trace writers remained blocked. Node/gateway audits were present at success, and the signed receipt chain verified. A deterministic regression separately gates the gateway audit while tracing is blocked.

## Executed checks

| Command | Result and final exit |
| --- | --- |
| `node --test --import tsx tests/mcp-contract.test.ts tests/routing.test.ts` | 8/8; exit 0 after Slice A |
| `node --test --import tsx tests/coordinator-daemon.test.ts tests/work-coordinator.test.ts` | 28/28; exit 0 |
| `node --test --import tsx tests/trace.test.ts tests/mcp-contract.test.ts` | 22/22; exit 0 |
| `npm run verify` | 278/278 tests, typecheck, invariants, build, production audit with zero vulnerabilities, backend probe; exit 0 |
| `git diff --check` | exit 0 |
| Baseline/candidate sampler count probe | exit 0 |
| Matched real MCP timing | exit 0 |
| Blocked real MCP action/receipt proof | exit 0 |

Full verification ran once after executable changes; later changes only clarified README wording and packaged these evidence documents. The initial evidence script rejected top-level await outside an ESM package before starting services; changing its extension to `.mts` resolved that artifact issue without modifying source behavior or weakening gates.

Diff review confirmed the existing 16 public tools/order, explicit routing without fallback, unchanged owner/client/grant/root/private-state/budget/profile/plan controls, FIFO/lease/repository exclusion, fail-closed daemon behavior, and no invariant-definition/key/authoritative-state changes or new dependencies. The original checkout and its untracked Python cache were preserved.

## Deployment recommendation

Review this source candidate before separately authorizing installation. Reinspect the then-current approved coordinator-mediated installer and completion/health procedure. This base exposes `npm run install:macos`, immutable runtime staging, the one-shot reload helper and `install-macos.status.json`; historical wait/health package-script names are not present in this reviewed base. Do not run installed services from checkout `dist`, manually replace private state, or enable access to satisfy acceptance. After authorization require candidate runtime identity, healthy connected gateway/node, exact expected node count, preserved owner access/profile, clean queue/lease state and a useful real ChatGPT/Claude operation before claiming installed improvement.
