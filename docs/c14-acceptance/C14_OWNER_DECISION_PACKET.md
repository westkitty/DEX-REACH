# C14 owner decision packet

## Current source note — 2026-10-10 maximum-scope v2 campaign

Decision 1 below is historical: owner source authority selected completion of accepted ADR-0003, and semantic negotiation, actual SSE and genuine compiled historical interoperability now exist. Remaining decisions concern installed maintenance, actual connector capability, ecosystem/human acceptance, and any future remote reconciliation/task-expiry contract.

Evidence and exact validation/publication boundaries: [../c14-compatibility/C14_V2_COMPLETION_REPORT.md](../c14-compatibility/C14_V2_COMPLETION_REPORT.md).
C13 NOT PASS; E7 HOST CAPABILITY BLOCKED; C14 program PARTIAL; C15 BLOCKED.

This packet is intentionally decision-shaped. No decision below was applied by
the executor.

## 1. Protocol migration scope

**Decision:** implement ADR-0003 Protocol v2 dual-stack, explicitly narrow a
specific release to the existing Protocol v1 capability contract, or delay
release until v2 interoperability is proven.

**Evidence:** current source remains Protocol v1 with capability-based durable
task behavior; C14-F2 passes current-source combinations but genuine v1/v2
wire interoperability is unsupported. DEX’s contract registry identifies the
protocol negotiation contract as version 2.0.

**Recommended narrow option:** do not relabel v1 as v2. For the current source
candidate, explicitly record a release scope limited to the v1 capability
contract only if the owner accepts the migration implication; otherwise delay.

**Authority required:** owner/product architecture decision and release-scope
approval. After approval, the executor may implement and test the selected
contract on this branch only.

**Acceptance evidence:** ADR update or release-scope record, mixed-version
matrix, focused regressions, full gates, and exact hosted CI at the selected
revision.

## 2. Installed and physical chaos window

**Decision:** authorize or decline a bounded MacBook maintenance window covering
the exact installed gateway, node, coordinator, and worker services.

**Evidence:** source and loopback chaos pass; physical interruption remains
blocked. No installed process was signaled in this campaign.

**Recommended option:** defer until a named window, exact service list, stop
conditions, rollback capsule, owner-state readback, and post-recovery task
proof are approved.

**Authority required:** explicit owner maintenance authority. The executor may
then run only the approved service interruption sequence and reconcile every
uncertain outcome before any retry.

**Acceptance evidence:** exact installed revision, process ownership, service
health, same-task recovery/no-replay proof, zero leaked leases/tickets,
preserved credentials/policy, and rollback readiness.

## 3. C14/C15 release and integration disposition

**Decision:** keep PR #16 draft and C15 blocked, or approve a separate review and
merge sequence after all release blockers are resolved.

**Evidence:** PR #16 is draft against `c13-worker-repair`; exact-head hosted
validation and CodeQL pass. PR #15 is separate and remains open/draft. DEX
ecosystem conformance is contract-mapped but not a REACH runtime integration.

**Recommended option:** keep PR #16 draft and do not merge. Resolve the
protocol decision, ecosystem tests, physical/E7 boundary, and human acceptance
first.

**Authority required:** owner merge/release authority, plus any DEX repository
coordination authority. No merge is performed by this packet.

**Acceptance evidence:** approved base/merge order, final exact SHA, hosted
checks tied to that SHA, DEX conformance evidence, installed acceptance, and
release notes that preserve all partial/unknown states.

## Current owner actions ranked by unblock value

1. Decide the ADR-0003 v1/v2 release scope; this determines whether migration
   work is required or can be explicitly bounded.
2. Provide a supported E7/installed-chaos capability and maintenance window;
   this is the largest remaining runtime evidence blocker.
3. Decide whether to authorize DEX ecosystem conformance integration and the
   eventual PR/release path; this controls C15 entry.
