# C14-F mixed-version compatibility and migration safety

## Verdict

**C14-F: PASS at source and isolated loopback-fixture scope; PARTIAL for installed mixed-version migration.**

The implementation keeps the integer v1 transport marker for historical authentication while adding semantic `1.0`/`2.0` offers, capability intersection, an explicit hello acknowledgement, and content-free task progress frames. It does not claim installed mixed-version interoperability or public connector migration.

## Actual protocol model

`REACH_PROTOCOL_VERSION` is the integer `1`. The node hello carries optional capability metadata, including `durable_tasks`. The gateway admits only the exact current protocol version during the real node handshake and authenticates the same version in transport proofs. Durable routing is then decided from the selected node's current hello capability, with strict `=== true` handling.

ADR-0003's semantic versions are carried in hello frames rather than by changing the signed integer transport field. The gateway admits only the negotiated intersection; the node defaults to v1 compatibility until it receives a v2 acknowledgement. Durable requests therefore cannot silently fall back.

## Matrix classification

The fixtures below model current source behavior using synthetic node hello records and in-memory MCP transport. They are not old or new deployed binaries.

| Matrix | ADR expectation | Current observed behavior | Classification |
| --- | --- | --- | --- |
| A: gateway v2 / node v2 / durable | Full v2 durable handle | `2.0` is acknowledged with the intersected durable capabilities; durable routing returns the existing `rtsk_` handle path. | IMPLEMENTED_AND_TESTED |
| B: gateway v2 / node v2 / synchronous | Supported `sync_legacy` | Shared v2 connection still accepts ordinary request/response dispatch without a durable envelope. | IMPLEMENTED_AND_TESTED |
| C: gateway v2 / node v1 / durable | Explicit capability refusal | Negotiated `1.0` lacks durable admission; registry refuses before dispatch or handle creation. | IMPLEMENTED_AND_TESTED |
| D: gateway v2 / node v1 / synchronous | Standard v1 synchronous execution | Legacy node remains routable synchronously; MCP `auto` fallback stays explicitly labelled. | IMPLEMENTED_AND_TESTED |
| E: gateway v1 / node v2 / synchronous | Node runs in v1 compatibility mode | The v2 node advertises v1 compatibility and accepts the legacy synchronous path; the loopback fixture records `1.0` admission. | IMPLEMENTED_AND_TESTED |
| F: gateway v1 / node v2 / durable | Legacy gateway rejects at ingress | Current v1-configured gateway refuses the durable envelope; the v2 node also refuses if a historical gateway forwards it without a v2 acknowledgement. | IMPLEMENTED_AND_TESTED |

## Focused behavior covered

The [C14-F matrix test](../../tests/c14-mixed-version.test.ts) and [loopback fixture](../../tests/c14-protocol-v2-loopback.test.ts) prove:

- a legacy-capability node receives an explicitly labeled synchronous fallback only in `mode=auto`;
- `mode=durable` returns `CAPABILITY_UNSUPPORTED_ON_NODE` without dispatching, creating a task, or fabricating a handle;
- a task-capable node preserves the exact node ID, actor identity, operation, and durable start envelope;
- missing, empty, false, and malformed capability metadata fail closed;
- reconnect/re-registration replaces stale capability authority;
- a selected node's request is never sent to another registered node;
- semantic v2 capability intersection and explicit v1-only refusal;
- isolated current-v2 and historical-v1 hello frames over IPv4 loopback with temporary synthetic state;
- the v2 node remains synchronously compatible when the gateway admits only v1;
- task progress frames are content-free and bounded at the node emission boundary.

Existing MCP contract tests cover the 16 first-class actions plus `reach_task`, lifecycle action routing, result shape, and no-breaking-schema behavior. Existing routing tests cover unknown/offline/revoked nodes and no fallback. Existing transport-auth tests cover wrong protocol refusal, proof identity, replay, and revocation. Durable execution and C14-A/B/C tests cover task identity, actor/policy binding, result binding, ambiguity preservation, and no replay.

## Security and migration boundaries

No capability is inferred from a missing or malformed hello. No durable request is downgraded to synchronous behavior. The fallback is explicit, selected-node scoped, and carries `supported: false`; it is not a durable result. Durable lifecycle requests remain exact-node and task-identity bound. No cross-node task retrieval, cancellation, or result substitution path is introduced.

The source envelope is dual-stack for node WebSocket transport. Public MCP endpoint versioning, six-month deprecation governance, installed migration, and external connector compatibility remain separate release gates.

## Evidence limits

The matrix is source-level and fixture-based. No physical v1 binary, v2 binary, installed mixed-version service, public connector refresh, live gateway migration, credential change, or production restart was performed. C13 remains NOT PASS, E7 remains BLOCKED — HOST CAPABILITY, and C14 overall remains incomplete.
