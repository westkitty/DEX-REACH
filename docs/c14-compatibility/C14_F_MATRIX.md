# C14-F mixed-version compatibility and migration safety

## Verdict

**C14-F: PASS at focused current-source compatibility scope; PARTIAL for the ADR-defined v1/v2 migration matrix.**

The current implementation is Protocol v1 with independently advertised node capabilities. It does not implement the ADR-0003 Protocol v2.0 handshake or a genuine v1/v2 dual-stack transport. The focused fixture therefore verifies the supported current contract and explicit refusal boundaries. It does not claim historical binary interoperability or installed mixed-version interoperability.

## Actual protocol model

`REACH_PROTOCOL_VERSION` is the integer `1`. The node hello carries optional capability metadata, including `durable_tasks`. The gateway admits only the exact current protocol version during the real node handshake and authenticates the same version in transport proofs. Durable routing is then decided from the selected node's current hello capability, with strict `=== true` handling.

This differs from ADR-0003, which defines semantic major/minor versions `v1.0` and `v2.0`, capability headers/frames, capability intersection, and a six-month dual-stack window. The repository currently has no `2.0` wire constant, no `X-Reach-Protocol-Version: 2.0` negotiation, no v2 task-event stream, and no v2 gateway/node admission path. Changing the integer from 1 to 2 would not implement those requirements and was not done.

## Matrix classification

The fixtures below model current source behavior using synthetic node hello records and in-memory MCP transport. They are not old or new deployed binaries.

| Matrix | ADR expectation | Current observed behavior | Classification |
| --- | --- | --- | --- |
| A: gateway v2 / node v2 / durable | Full v2 durable handle | No v2 handshake or wire path exists. Current v1 task-capable path is tested separately. | UNSUPPORTED_BY_CURRENT_SOURCE |
| B: gateway v2 / node v2 / synchronous | Supported `sync_legacy` | No v2 gateway/node pair exists. Current v1 synchronous dispatch remains supported. | UNSUPPORTED_BY_CURRENT_SOURCE; v1 equivalent IMPLEMENTED_AND_TESTED |
| C: gateway v2 / node v1 / durable | Explicit capability refusal | Current capability-based gateway refuses durable work when the selected node lacks `durable_tasks`; no request or handle is created. A genuine v2/v1 binary pair was not exercised. | IMPLEMENTED_AND_TESTED at current v1 boundary; v2 pair UNSUPPORTED |
| D: gateway v2 / node v1 / synchronous | Standard v1 synchronous execution | `mode=auto` performs the selected-node synchronous request and labels the result `synchronous-fallback`; no durable guarantee is emitted. | IMPLEMENTED_AND_TESTED at current v1 boundary |
| E: gateway v1 / node v2 / synchronous | Node runs in v1 compatibility mode | Current gateway and node handshake share Protocol v1; no version-distinct v2 node can register. Current v1 synchronous path is tested. | UNSUPPORTED_BY_CURRENT_SOURCE; v1 equivalent IMPLEMENTED_AND_TESTED |
| F: gateway v1 / node v2 / durable | Legacy gateway rejects at ingress | Current handshake and proof authentication reject a protocol version other than 1; no v2 request is routed. | IMPLEMENTED_AND_TESTED refusal at current boundary; v2 pair UNSUPPORTED |

## Focused behavior covered

The new [C14-F matrix test](../../tests/c14-mixed-version.test.ts) proves:

- a legacy-capability node receives an explicitly labeled synchronous fallback only in `mode=auto`;
- `mode=durable` returns `CAPABILITY_UNSUPPORTED_ON_NODE` without dispatching, creating a task, or fabricating a handle;
- a task-capable node preserves the exact node ID, actor identity, operation, and durable start envelope;
- missing, empty, false, and malformed capability metadata fail closed;
- reconnect/re-registration replaces stale capability authority;
- a selected node's request is never sent to another registered node;
- the current source remains Protocol v1 and has no ADR-defined v2 wire path.

Existing MCP contract tests cover the 16 first-class actions plus `reach_task`, lifecycle action routing, result shape, and no-breaking-schema behavior. Existing routing tests cover unknown/offline/revoked nodes and no fallback. Existing transport-auth tests cover wrong protocol refusal, proof identity, replay, and revocation. Durable execution and C14-A/B/C tests cover task identity, actor/policy binding, result binding, ambiguity preservation, and no replay.

## Security and migration boundaries

No capability is inferred from a missing or malformed hello. No durable request is downgraded to synchronous behavior. The fallback is explicit, selected-node scoped, and carries `supported: false`; it is not a durable result. Durable lifecycle requests remain exact-node and task-identity bound. No cross-node task retrieval, cancellation, or result substitution path is introduced.

The current supported envelope is therefore safe for capability-based Protocol v1 operation. A genuine v2 migration requires a separately coordinated change covering semantic version parsing, handshake headers/frames, capability intersection, gateway/node admission, task-event streaming, public endpoint compatibility, deployed runtime coordination, and migration-window policy. This packet does not implement or install that migration.

## Evidence limits

The matrix is source-level and fixture-based. No physical v1 binary, v2 binary, installed mixed-version service, public connector refresh, live gateway migration, credential change, or production restart was performed. C13 remains NOT PASS, E7 remains BLOCKED — HOST CAPABILITY, and C14 overall remains incomplete.
