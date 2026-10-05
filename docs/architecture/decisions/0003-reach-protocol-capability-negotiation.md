# ADR-0003 — REACH Protocol Capability Negotiation and Legacy Compatibility

Status: Accepted
Date: 2026-10-05
Decision owners: DEX//REACH project

## Context

DEX//REACH currently operates on Protocol v1: synchronous RPC tool dispatch where remote MCP clients and ChatGPT actions wait on synchronous HTTP/WebSocket responses. For DEX//REACH 0.4 and DEX// 1.0, we are introducing Protocol v2, which supports durable task handles, asynchronous progress streaming, and long-running execution.

However, existing ChatGPT custom actions, older CLI installations, and loopback MCP test harnesses rely on Protocol v1 contracts. If we break backward compatibility or silently downgrade requested durable operations into transient calls, clients will experience unpredictable timeouts or lost execution handles. We must define the capability negotiation protocol, versioning schema, mixed-version rules, and explicit error semantics before any protocol code is implemented.

## Decision

### 1. Protocol Versioning Scheme

Protocol versions are strictly semantic major.minor versions:
- `v1.0`: Synchronous RPC dispatch. Immediate request-response tool invocations across 16 first-class actions and 22 compatibility tools (`DEX-INV-017`).
- `v2.0`: Asynchronous / durable execution capable. Supports `durable_tasks`, task event streaming, async cancellation, and task reconciliation.

### 2. Capability Negotiation Handshake

Capabilities are negotiated during connection establishment and declared in request headers / frames.

#### Standard Capability Identifiers
- `durable_tasks`: Ability to create, poll, and manage `rtsk_` durable task records.
- `task_event_stream`: Ability to stream progress events via Server-Sent Events (SSE) or WebSocket frames.
- `task_reconciliation`: Ability to execute reconciliation probes on `AMBIGUOUS` tasks.
- `two_phase_plan`: Standard planned mutation protocol (`DEX-INV-010`, `DEX-INV-020`).

#### Handshake Headers
- Inbound: `X-Reach-Protocol-Version: 2.0`, `X-Reach-Capabilities: durable_tasks,task_event_stream`
- Outbound: `X-Reach-Protocol-Version: 2.0`, `X-Reach-Capabilities-Admitted: durable_tasks`

### 3. Preservation of Legacy v1 Behavior

1. **Direct Tool Preservation**: Invocations of existing MCP tools (`reach_inspect`, `reach_status`, `reach_trust_report`, `reach_adb_devices`) that do not request durable task handling continue to execute synchronously with identical input/output schemas.
2. **No Breaking Schema Changes**: Existing OpenAPI specifications for the ChatGPT connector and Model Context Protocol SDK v2 endpoints retain their current tool signatures.
3. **No Phantom Tools**: The remote MCP tool surface remains strictly bounded to the authorized 16 first-class actions and safe compatibility surface (`DEX-INV-005`, `DEX-INV-017`).

### 4. Mixed Version Gateway and Node Interactions

In heterogeneous deployment environments (e.g., gateway upgraded to v2 while a local node is still v1, or vice-versa):

| Gateway Version | Node Version | Requested Mode | Resulting Behavior |
| :--- | :--- | :--- | :--- |
| `v2.0` | `v2.0` | `durable_tasks` | Full v2 durable execution. Returns task handle `rtsk_...`. |
| `v2.0` | `v2.0` | `sync_legacy` | Executes synchronously; internal task record created for audit. |
| `v2.0` | `v1.0` | `durable_tasks` | **EXPLICIT REFUSAL**: Returns `CAPABILITY_UNSUPPORTED_ON_NODE`. |
| `v2.0` | `v1.0` | `sync_legacy` | Standard v1 synchronous execution. |
| `v1.0` | `v2.0` | `sync_legacy` | Node runs in v1 compatibility mode; returns synchronous response. |
| `v1.0` | `v2.0` | `durable_tasks` | Gateway cannot route v2 request; rejects at gateway ingress. |

### 5. Strict Invariant: No Silent Downgrade

**Universal Prohibition**: If a caller explicitly requests durable execution (e.g. `durable: true` or specifies a durable task header), the gateway and node MUST NOT silently downgrade the operation to transient synchronous execution.
- If the node or gateway cannot provide durable persistence (e.g. node storage full, node running v1, or capability missing), it MUST return an immediate, explicit error:
  ```json
  {
    "error": "CAPABILITY_UNAVAILABLE",
    "requestedCapability": "durable_tasks",
    "supportedProtocolVersion": "1.0",
    "message": "Durable task execution requested but target node does not support capability 'durable_tasks'. Silent fallback is forbidden."
  }
  ```
- Silent fallback is forbidden because callers expecting a survivable task handle would otherwise lose tracking upon any network hiccup.

### 6. Connector and Public Schema Compatibility Boundaries

- The public ChatGPT connector OpenAPI document remains versioned under `/api/v1/` and `/api/v2/`.
- Introducing v2 task endpoints does not modify the v1 path contracts.
- Public MCP tool descriptions and schema types continue to adhere strictly to Model Context Protocol specification standards.

### 7. Migration and Compatibility Window

- A minimum **6-month dual-stack compatibility window** is enforced after Protocol v2 general release.
- Deprecation of Protocol v1 will require an explicit governance decision and major version bump (DEX//REACH 1.0).

## Consequences

### Positive
- Ensures complete backward compatibility for existing ChatGPT connectors and local MCP clients.
- Prevents catastrophic silent downgrades where users mistakenly believe an operation is durable.
- Clean capability negotiation prevents version fragmentation across multiple worker nodes.

### Costs / Tradeoffs
- Gateway and node must support dual-path routing (synchronous dispatch vs asynchronous task handles).
- Additional header parsing and capability negotiation checks on session initialization.

## Validation
1. Capability handshake unit tests validating correct capability intersection.
2. Negative fixture test proving immediate explicit error on unsupported capability request (no silent downgrade).
3. Mixed-version compatibility test matrix proving correct refusal and pass-through paths.

## Revisit When
- Model Context Protocol natively standardizes an official asynchronous task execution primitive across all compliant servers.

## Supersedes
None. (Foundational ADR for Phase C1).
