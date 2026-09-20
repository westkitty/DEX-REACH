# Coordinator runtime modernization

## Outcome

Install the validated `df08077` branch into the persistent macOS gateway and
node runtime, then make local scheduling observable, resource-aware and safe
for browser-facing clients without expanding the existing sixteen-action MCP
contract or weakening credential isolation.

## Scope and decisions

- The coordinator daemon is the sole live owner of coordinator mutation and
  host observation. Its Unix-domain socket is local-user-only (`0700`
  directory, `0600` socket); it has no OAuth, node, gateway, or provider
  secrets in its environment.
- The daemon caches a *sanitized* host observation for a short bounded TTL.
  It stores aggregate pressure and safe process labels only. Raw arguments,
  command text, prompts, tokens, roots and credentials are neither cached nor
  emitted.
- Existing `light` / `medium` / `heavy` callers remain compatible through a
  deterministic compatibility map. New `WorkBundle` resources express CPU,
  memory, I/O class, network class, repository-write ownership and machine
  exclusivity. Admission uses vector budgets and FIFO fairness; safe backfill
  may only admit a later job when it cannot delay the queue head.
- Progress is a bounded, redacted event stream associated with lease/ticket
  IDs. Browser clients receive a snapshot and monotonic cursor through the
  existing result/status flow, with reconnect/resume rather than unbounded
  server-held streams.
- The public MCP contract remains exactly sixteen first-class actions. Queue
  and latency summaries are added as backward-compatible data on the existing
  node/status response; its description directs a client to inspect it before
  submitting work. This makes the state available to the plugin tool context,
  but it cannot alter a model's private chain of thought.
- A persistent workspace worker is credential-free by construction: no state
  directory secrets, OAuth bearer tokens, node credentials, provider API keys,
  SSH agent or secret-injection environment pass into it. It can only perform
  explicitly allowlisted workspace-safe work; every privileged operation stays
  on the existing per-request, policy-checked node path.

## Existence and ownership check

| Concern | Existing owner | Decision |
| --- | --- | --- |
| Lease/ticket persistence and admission | `src/shared/work-coordinator.ts` | Extract durable state and pure policy helpers; route live mutation through a new daemon client/server owner. |
| Host probes and process classification | `src/shared/machine-capacity.ts` | Keep classification here; add compact resource estimates and sanitized observation snapshots. |
| CLI work lifecycle | `src/shared/work-run.ts`, `scripts/dex-reach.ts` | Use the socket client transparently, retaining a test-only/direct fallback only until the daemon is installed. |
| Persistent services | `scripts/install-macos.ts`, `scripts/lib/service.ts` | Add a third LaunchAgent for the daemon and make the one-shot reloader stage all three atomically. |
| Node execution and secret injection | `src/node/main.ts` | Keep authority and injection here; add the separate constrained workspace-worker launcher. |
| Browser MCP schema and transport | `src/gateway/mcp.ts`, `src/gateway/main.ts` | Preserve the sixteen tools and add status payload / resumable progress data without a seventeenth action. |

No existing module owns a single-writer Unix socket daemon or safe queue
telemetry. Those are new, separately named modules rather than extra side
effects inside the gateway or node process.

## Implementation slices

### 1. Establish the installed baseline

1. Fast-forward the checkout to the remote branch and verify it is clean and
   exactly `origin/claude/work-coordinator-cpcug3`.
2. Run the repository's exact validation gate at that head.
3. Acquire the existing exclusive coordinator lease, run `npm run
   install:macos`, release the lease, then read the one-shot install status
   only after its restart window.
4. Prove both LaunchAgents point at the current checkout and report live
   version/health. If the install helper reports any failed service, stop and
   repair that installation failure before product changes.

### 2. Introduce the local daemon safely

1. Define a versioned JSON-line socket protocol: `status`, `acquire`,
   `heartbeat`, `release`, and `events` commands; validate every request and
   response with bounded schemas.
2. Implement a daemon state owner under `src/coordinator/`. It takes the
   existing file lock during migration/recovery only, creates the socket with
   owner-only permissions, removes stale sockets safely, and serializes all
   state mutation.
3. Add a two-second observation cache plus an explicit invalidation on lease,
   release, heartbeat expiry, warning pressure, and degraded state. Cache
   failures conservatively; no cache hit may turn a rejected request into an
   admitted one after its TTL.
4. Add a socket client to `work-coordinator` / `work-run`; detect an absent
   daemon distinctly from a rejected request. The compatibility fallback must
   be disabled for installed production use so two writers cannot exist.
5. Add daemon start/stop and socket protocol tests, including stale-socket
   recovery, permission mode, malformed input, cached observation expiration,
   and concurrent acquire serialization.

### 3. Replace scalar slots with work bundles

1. Add a compact `WorkBundle` schema and explicit legacy mapping. Persist the
   normalized bundle, not arbitrary caller metadata.
2. Extend host capacity with resource budgets and bundle accounting. Preserve
   repository mutate/exclusive locks as hard constraints independent of vector
   capacity.
3. Replace scalar count admission with vector fit plus FIFO queue fairness.
   Record the deterministic reason for each queue decision.
4. Migrate CLI flags and lease display while accepting legacy workload flags;
   update operator documentation and regression coverage for all mappings.

### 4. Add privacy-safe progress and metrics

1. Add bounded event records for enqueue, admit, heartbeat, phase progress,
   release, reject, cache outcome and classifier result. Each event has a
   sequence cursor and safe label policy.
2. Compute aggregate queue wait percentiles, active/queued bundle totals,
   cache-hit rate, and classifier false-positive/false-negative feedback
   counters. Keep individual process evidence bounded and sanitized.
3. Return live queue summary, latency metrics and an event cursor in the
   existing node/status tool payload. Extend `reach_result_read` only if it is
   the current compatible result channel for paged events; do not add a tool.
4. Add gateway transport tests for reconnecting a session, re-listing all
   sixteen actions, and receiving queue fields without leaking credentials or
   raw command arguments.

### 5. Add the credential-free persistent workspace worker

1. Define a narrow worker protocol and allowlist of workspace-safe operations.
   Reject network credential use, secret references, unsafe adapters and
   repository mutation unless a normal node authorization request separately
   approves it.
2. Launch it through its own LaunchAgent or supervised child with a scrubbed
   environment, per-account private runtime directory, bounded work queue and
   explicit shutdown/restart behavior.
3. Route only eligible read/analysis tasks to it; fall back to the node's
   existing authorization path for every operation requiring secrets,
   capabilities, a plan commitment or external provider identity.
4. Test environment scrubbing, refusal boundaries, worker crash recovery and
   proof that ordinary authorized node execution remains unchanged.

### 6. Repair the browser connector and prove the live contract

1. After the gateway restart, perform an authenticated live MCP initialization
   and `tools/list` check: exactly sixteen current actions, not the cached
   twelve-action view.
2. Refresh/reconnect the configured browser connector so it discards the old
   session/schema cache. If the browser provider requires owner interaction
   for OAuth consent, present that one precise step rather than claiming it
   was completed.
3. Use the browser-facing tool path to observe the queue summary and progress
   cursor, then test an interrupted session reconnecting from that cursor.
4. Update `OPERATIONAL_STATE.md` only with independently observed evidence and
   mark browser UI consent as unverified if the provider blocks automation.

## Verification

- `npm run verify` at the installed commit before and after source changes.
- `npm run typecheck`, focused daemon/bundle/event/worker tests, then the full
  repository test suite, `npm run build`, audit and backend probe.
- `git diff --check` and a clean staged diff review before each commit.
- macOS launchd status plus `~/.dex-reach/install-macos.status.json` after
  each persistent-service update.
- Authenticated live MCP `tools/list` with the exact sixteen-action contract,
  queue telemetry and a reconnect test. This is distinct from browser UI
  acceptance, which requires an observed browser session.

## Risks and stop conditions

- Do not install a checkout behind its remote branch.
- Do not run daemon and direct coordinator writers concurrently in production.
- Do not persist or stream secret-bearing fields; a suspected leak stops the
  telemetry/worker slice for remediation.
- Do not claim browser-plugin ``thinking`` visibility; only tool descriptions
  and returned queue context are under product control.
- Strict test-driven development was not requested; use focused regression
  tests before each slice and the repository gate after each coherent change.
