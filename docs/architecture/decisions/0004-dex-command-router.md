# ADR-0004 — DEX 1.0 Command Router on the REACH Boundary

Status: Proposed (design). The router skeleton in `src/shared/dex-command-router.ts` implements only the fixture-tested subset in section 9. No product integration is claimed.
Date: 2026-10-11
Decision owners: DEX//REACH project
Companion decisions: DEX-owned ADR-0013 (50-command system and manifests), ADR-0014 (product adapter interface), ADR-0016 (provenance graph and derived search projections), ADR-0017 (ecosystem control vocabulary), as listed in [the decision index](./README.md).

## 0. Verification boundary

This ADR was written in a session that could not read `westkitty/DEX`: the repository returned HTTP 403 for both git transport and the GitHub API. Therefore:

- The DEX manifest, the `DexProductAdapter` v1.0.0 text and the companion ADRs were **not** read. Every statement below about DEX-owned contracts is a REACH-side requirement, not a description of DEX behaviour.
- The manifest schema in section 3 is **REACH's consumption schema**. It must be reconciled against DEX ADR-0013 and ADR-0014 before any real manifest is loaded. Where they differ, DEX wins and this ADR is amended.
- The fixture in `tests/fixtures/dex-router/` is **synthetic**. Its command ids use a `FIXTURE//` prefix and are not DEX commands. The real 50-command roster is not reproduced anywhere in this repository.

## 1. Context

The master plan requires a manifest-driven 50-command language and versioned product adapters for SESSION, DROPZONE, PAIR, CAPSULE, MUSEUM, REMIX, SIDEQUEST and WITNESS. `docs/c14-acceptance/C14_ECOSYSTEM_CONFORMANCE.md` on the C14 branch records that REACH has no consumer for these yet. REACH today exposes its own operation catalogue (`src/shared/operations.ts`, `DEX_OPERATIONS`) and a fixed MCP tool surface (ADR-0003, DEX-INV-005 "no phantom tools").

Three forces constrain the design:

1. **Node authority.** ADR-0001 makes the node the sole authority on task state and execution. The gateway may route; it may not decide outcomes.
2. **No silent downgrade and no guessing.** ADR-0003 forbids silent downgrade; ADR-0001 forbids floating tasks across nodes. A command router that picks "some node that can do it" violates both.
3. **Trust domains that must stay separate.** PAIR PRIVATE/SEALED data, DROPZONE inputs and WITNESS evidence must not leak into the command plane, search or creative products.

## 2. Decision summary

- REACH consumes the DEX command manifest **as data**. It contains one router with one dispatch table. It does not contain 50 command engines, and it does not register 50 MCP tools.
- A manifest command can only resolve to an operation already in REACH's catalogue. A manifest cannot introduce code, shell text or a new operation.
- Every request names one exact `node_id`. There is no fallback to another node, no capability-based pick and no default node.
- Versions are pinned by major number. Mismatches are structured refusals, never coercions.
- PRIVATE/SEALED data is excluded from routing, projections and handoffs unless a promotion record exists. DROPZONE input is untrusted until accepted. WITNESS evidence is isolated, and the WITNESS-to-REMIX edge is refused in code.
- Search projections are derived and rebuildable only.
- Handoffs are validated by the receiver, which does not trust the sender's authorization claims.

## 3. Manifest consumption

### 3.1 Shape (REACH consumption schema v1)

```json
{
  "schema": "dex.command-manifest",
  "contractVersion": "1.0.0",
  "synthetic": false,
  "commands": [
    {
      "id": "DEX//NEXT",
      "version": "1.0.0",
      "product": "SESSION",
      "safetyClass": "PURE_READ_IDEMPOTENT",
      "dataClass": "PUBLIC",
      "inputOrigin": "owner",
      "reachOperation": "dex.trustReport"
    }
  ]
}
```

Field rules:

- `schema` must equal `dex.command-manifest`.
- `contractVersion` is semver. Its major is the contract major that REACH pins (section 4).
- `id` matches `^[A-Z][A-Z0-9_]{1,31}//[A-Z][A-Z0-9_]{1,31}$`. Ids are unique within a manifest. The example `DEX//NEXT` is the only DEX command name this ADR cites, and it is cited only because the REACH conformance record cites it.
- `version` is semver for the command itself.
- `product` is one of `SESSION`, `DROPZONE`, `PAIR`, `CAPSULE`, `MUSEUM`, `REMIX`, `SIDEQUEST`, `WITNESS`.
- `safetyClass` is one of the five REACH safety classes (ADR-0002, `SAFETY_CLASSES`): `PURE_READ_IDEMPOTENT`, `SIDE_EFFECTING_IDEMPOTENT`, `PLAN_COMMIT`, `PROCESS_UNKNOWN_EFFECT`, `DESTRUCTIVE`.
- `dataClass` is `PUBLIC`, `PRIVATE` or `SEALED`.
- `inputOrigin` is `owner` or `dropzone`.
- `reachOperation` must be a key in `DEX_OPERATIONS`. It is the only execution target a command can have.
- `synthetic` is optional. A manifest that sets it to `true` is a fixture and must never be loaded in production. Real manifests do not set it.

### 3.2 Loader behaviour (fail closed)

The loader is a pure function over parsed JSON. It refuses:

- non-object input, wrong `schema`, or a `contractVersion` that is not semver (`MANIFEST_INVALID`);
- a contract major other than the pinned major (`DEX_CONTRACT_MAJOR_MISMATCH`, with `expectedMajor` and `actualVersion`);
- unknown keys at the top level or on any command (`MANIFEST_INVALID`). Forward-compatible additions require a schema revision, not silent tolerance;
- duplicate ids, an unrecognised enum value, or a missing required field (`MANIFEST_INVALID`).

The major check runs before field validation, so a future major with new fields produces a version refusal rather than a field error.

### 3.3 One router, not 50 engines and not 50 tools

- The router is a single lookup: `command id -> (product, safety, data class, input origin, reach operation)`, followed by the checks in section 5.
- Dispatch reuses the existing operation path (`executeOperation` / `nativeCall`) and its authorization, profile, budget, secret and task-record gates. The router adds no execution path.
- The MCP tool surface does not grow because of this ADR. Exposing a generic command entry point to remote clients is a separate decision that needs its own ADR and an update to the tool-surface invariants.

## 4. Versioning

- REACH pins `DEX_CONTRACT_MAJOR`. A manifest with a different major is refused, and so is a node that advertises a different adapter major.
- Minor and patch differences are accepted only where the schema revision allows them (section 3.2). A newer minor with unknown fields is refused, not ignored.
- A caller may pin a command major (`commandVersion`). A mismatch is refused (`COMMAND_MAJOR_MISMATCH`). No pin means "the manifest's current version".
- Every refusal is structured: `{ ok: false, code, message, details }`, where `code` comes from the closed list in section 7 and `details` is JSON-serialisable and free of secrets. Refusals never fall back to a different version, node or command.
- A node advertises `dex_command_router: true` and `productAdapters: { <PRODUCT>: "<semver>" }`. A missing capability is `CAPABILITY_UNSUPPORTED_ON_NODE`. An adapter major mismatch is `ADAPTER_MAJOR_MISMATCH`. Neither is downgraded to a legacy path, consistent with ADR-0003.

## 5. Exact node selection

Routing a command is a decision about exactly one node. The steps run in order, and the first failure is the refusal:

1. The request must name `nodeId`. Absence is `NODE_ID_REQUIRED`, even if one node is online.
2. `nodeId` is compared by exact string equality with the enrolled registry. There is no case folding, prefix match, alias, hostname lookup or "primary" default. No match is `NODE_NOT_FOUND`.
3. The node must be enrolled and online. Otherwise `NODE_NOT_ONLINE`. The refusal must not name, suggest or pick another node. This is DEX-INV-001 (ADR-0001 section 4): a task cannot float or migrate.
4. The node must advertise the router capability and the adapter major for the command's product.
5. Only then are input acceptance (section 6), data class (section 6) and catalogue membership checked.

No step may substitute a different node. A refusal's `details` may name the requested node, never another one.

## 6. Trust boundaries

### 6.1 PAIR PRIVATE/SEALED

- A command or projection item whose `dataClass` is `PRIVATE` or `SEALED` is **not** routable from a remote request, and not projectable, unless the request carries a `promotionRef`. Missing promotion is `DATA_NOT_PROMOTED`.
- Promotion is per item, owner-authorized and recorded in an append-only ledger. It is never bulk and never implied by a product's own state. Its record shape is an open question (section 10).
- Search projections and handoff payloads apply the same rule. Unpromoted PRIVATE/SEALED content is excluded from global search, cross-product payloads, receipts shared outside the node and logs.
- REACH holds no PAIR payload today. This section is the rule that any future PAIR consumer must satisfy.

### 6.2 DROPZONE input

- Any command whose `inputOrigin` is `dropzone` is refused (`INPUT_NOT_ACCEPTED`) unless the request carries an `acceptanceRef` naming an accepted input.
- Accepted or not, dropzone content is data. It is never parsed as a command, never executed and never used as a routing decision.

### 6.3 WITNESS evidence

- WITNESS is its own evidence trust domain. REACH may hold WITNESS evidence references in a namespace separate from every other product's state, and it never merges them into command or search state.
- **The WITNESS-to-REMIX mutation edge is forbidden.** The skeleton refuses every handoff whose source is `WITNESS` and whose target is `REMIX` (`WITNESS_REMIX_EDGE_FORBIDDEN`). This check is code, not manifest data, so no manifest can re-enable it. Any future relaxation requires a DEX-owned decision and a change to this ADR.

## 7. Refusal codes (closed list)

`MANIFEST_INVALID`, `DEX_CONTRACT_MAJOR_MISMATCH`, `COMMAND_MAJOR_MISMATCH`, `UNKNOWN_COMMAND`, `NODE_ID_REQUIRED`, `NODE_NOT_FOUND`, `NODE_NOT_ONLINE`, `CAPABILITY_UNSUPPORTED_ON_NODE`, `ADAPTER_MAJOR_MISMATCH`, `INPUT_NOT_ACCEPTED`, `DATA_NOT_PROMOTED`, `OPERATION_NOT_IN_CATALOGUE`, `HANDOFF_INVALID`, `WITNESS_REMIX_EDGE_FORBIDDEN`.

A new code requires an ADR amendment. Consumers must treat an unknown code as a refusal.

## 8. Search projections and handoffs

### 8.1 Search projections are rebuildable only

- A projection is derived from source records, carries a digest of its source, and is marked `rebuildable: true`.
- A projection is never authoritative. Nothing reads a projection as evidence, task state or policy.
- Deleting a projection is always safe. The rebuild must be deterministic: identical sources produce an identical projection and digest.
- Projections exclude PRIVATE/SEALED items that lack a promotion (section 6.1).

### 8.2 Handoffs are validated by the receiver

A handoff envelope is `{ handoffVersion, fromProduct, toProduct, command, schemaId, payloadSha256, dataClass, promotionRef? }`. The **receiver** validates it and does not trust the sender:

- `handoffVersion` major is pinned; `fromProduct`/`toProduct` are known products;
- `command` exists in the receiver's own manifest, with a matching product;
- `payloadSha256` is 64 lowercase hex characters;
- `dataClass` PRIVATE/SEALED requires `promotionRef` (`DATA_NOT_PROMOTED`);
- the WITNESS-to-REMIX edge is refused (section 6.3);
- any failure is `HANDOFF_INVALID` with a reason, and nothing is applied.

The sender's authorization claims are informational. The receiver re-authorizes under its own policy.

## 9. What the skeleton implements now

Implemented, with fixture tests (`tests/dex-command-router.test.ts`):

- the loader (section 3.2), including major-first ordering and the closed refusal list;
- command routing checks in section 5 order, section 6.2 and the PRIVATE/SEALED part of section 6.1;
- the WITNESS-to-REMIX refusal and receiver-side handoff validation (sections 6.3 and 8.2);
- a projection filter that excludes unpromoted PRIVATE/SEALED items and records a source digest (section 8.1).

Not implemented, deliberately:

- no MCP tool registration and no change to the advertised tool surface;
- no dispatch. The router returns a plan (`nodeId`, command, `reachOperation`) and executes nothing;
- no persistence of routing decisions, promotion ledger or acceptance records;
- no connection to the live registry. The router takes a plain node view so it can be tested without a gateway;
- no DEX product behaviour, adapters, or the real 50-command roster.

## 10. Open questions for DEX (must be answered before integration)

1. The authoritative manifest shape, field names, and whether `DEX//NEXT` and other ids match section 3.1.
2. Whether DEX ADR-0014's `DexProductAdapter` v1.0.0 uses the same product ids and semver rules.
3. The promotion record: its fields, who may promote, and how a promotion is revoked.
4. The DROPZONE acceptance record and who may accept.
5. The complete WITNESS edge list. This ADR only forbids WITNESS-to-REMIX.
6. Whether any DEX command must reach a REACH operation that is not in `DEX_OPERATIONS`. If so, that is a catalogue change with its own safety-class review, not a manifest change.

## 11. Consequences

- Positive: one reviewable routing point; the manifest can change without new code; exact-node and version refusals are testable; trust rules are enforced in code, not left to data.
- Costs: the router is a thin layer with no product behaviour behind it. Until DEX answers section 10, it can only be proved against a synthetic fixture.
- Risk: a manifest that claims an operation REACH does not have is refused, so DEX must not ship commands that depend on unlisted operations without an agreed catalogue change.

## 12. Validation

The fixture-backed tests cover: the loader's refusals; unknown commands (including case and whitespace variants); command and contract major mismatches; missing node id; an offline node with a capable online alternative (the refusal must not name the alternative); missing capability and adapter major mismatch; dropzone acceptance; PRIVATE/SEALED without promotion; catalogue membership; the WITNESS-to-REMIX edge; receiver-side handoff validation; and projection exclusion and determinism.

These tests prove the skeleton's logic against a synthetic fixture. They do not prove any DEX integration.
