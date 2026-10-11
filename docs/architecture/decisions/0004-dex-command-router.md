# ADR-0004 — DEX 1.0 Command Router on the REACH Boundary

Status: Proposed. The REACH-side adapter and router are implemented and tested against synthetic fixtures in the real DEX entry shape, and the adapter has been run against a real DEX checkout (section 0). No command is routable, because no authoritative REACH mapping exists (section 3.5). No product integration is claimed.
Date: 2026-10-11 (amended 2026-10-11 after reading the DEX source; see section 0)
Decision owners: DEX//REACH project
Companion decisions: DEX-owned ADR-0013 (50-command system and manifests), ADR-0014 (product adapter interface), ADR-0016 (provenance graph and derived search projections), ADR-0017 (ecosystem control vocabulary), as listed in [the decision index](./README.md).

## 0. Verification boundary

The first version of this ADR was written when `westkitty/DEX` returned HTTP 403, so its manifest schema was a REACH invention. This amendment was written after DEX became readable. What was read, and at what version, is recorded in [`../dex-contract-alignment.md`](../dex-contract-alignment.md):

- DEX `packages/router/src/manifest.ts` (manifest 1.0.0), `packages/router/src/index.ts`, `packages/contracts/src/productAdapter.ts`, and accepted ADR-0013, ADR-0014, ADR-0016 and ADR-0017, at DEX commit `57693daa`.
- `scripts/dex-contract-conformance.ts` runs the DEX manifest through the adapter described below and reports provenance and counts. It was run against that commit: 50 commands, all twelve scopes present, ten modifiers matching REACH's pin, 0 routable, 50 unroutable.

Not verified: `dex-command-manifest.v1.json`, which DEX ADR-0013 names as a publication target, **does not exist** in DEX. The authoritative artifact is the TypeScript source `manifest.ts`. DEX has no concept of a REACH operation, so nothing in DEX grants a mapping. No DEX private source or roster is stored in this repository; the repository is public, and the tests use synthetic commands named `DEX//FIXTURE_*`.

## 1. Context

The master plan requires a manifest-driven 50-command language and versioned product adapters for the eight DEX products. `docs/c14-acceptance/C14_ECOSYSTEM_CONFORMANCE.md` records that REACH had no consumer for these. REACH exposes its own operation catalogue (`src/shared/operations.ts`, `DEX_OPERATIONS`) and a fixed MCP tool surface (ADR-0003, DEX-INV-005 "no phantom tools").

Three forces constrain the design:

1. **Node authority.** ADR-0001 makes the node the sole authority on task state and execution. The gateway may route; it may not decide outcomes.
2. **No silent downgrade and no guessing.** ADR-0003 forbids silent downgrade; ADR-0001 forbids floating tasks across nodes. A command router that picks "some node that can do it" violates both.
3. **Trust domains that must stay separate.** PAIR PRIVATE/SEALED data, DROPZONE inputs and WITNESS evidence must not leak into the command plane, search or creative products.

DEX owns command semantics; REACH consumes them (DEX ADR-0013, ADR-0014). DEX products must not depend on the REACH runtime (DEX ADR-0014 section 2.3), so the dependency runs one way: REACH reads DEX contract data, DEX never calls REACH.

## 2. Decision summary

- REACH consumes the canonical DEX command manifest **as data** (`src/shared/dex-canonical-contract.ts`). Every canonical command identity is preserved. REACH contains one router with one dispatch table. It does not contain 50 command engines, and it does not register 50 MCP tools.
- A DEX command reaches REACH only through an **explicit REACH-owned mapping** that names the authoritative document granting it (`ReachMappingTable`). A command with no mapping is **unroutable**, and the refusal says so (`REACH_MAPPING_ABSENT`). A mapping is never derived from a command name, scope, workflow id or app command.
- A mapping can name only operations already in REACH's catalogue, cannot be riskier than the DEX mutation level, and cannot weaken a scope's gates.
- Every request names one exact `node_id`. There is no fallback to another node, no capability-based pick and no default node.
- Versions are pinned by major number. Mismatches are structured refusals, never coercions.
- PRIVATE/SEALED data is excluded from routing, projections and handoffs unless a verified promotion exists. DROPZONE input is untrusted until accepted. WITNESS evidence is isolated, and the WITNESS-to-REMIX edge is refused in code.
- Search projections are derived and rebuildable only.
- Handoffs are validated by the receiver against its own `acceptedContracts`, not by the sender's claims.

## 3. Manifest consumption

### 3.1 Canonical shape (owned by DEX)

The envelope is `{ manifestVersion, commands, synthetic? }`, where `commands` is DEX's `DEX_COMMAND_MANIFEST` and `manifestVersion` is `DEX_COMMAND_MANIFEST_VERSION`. Each entry is DEX's `DexCommandManifestEntry`, with all fifteen fields required: `name`, `canonical` (`DEX//<name>`), `slash` (`/<name>` lowercase), `aliases`, `commandClass`, `scope`, `mutationLevel`, `objectKinds`, `supportedModifiers`, `workflowId`, `outputs`, `skillBinding`, `effect`, `appCommand`, `trustDomain`.

REACH uses `canonical`, `scope`, `mutationLevel` and `supportedModifiers`. `aliases`, `slash`, `workflowId`, `outputs`, `skillBinding`, `effect` and `appCommand` are retained as inert, descriptive data. REACH never executes or interprets them, and a routed plan never carries them. Alias, slash and prose resolution is DEX's parser; REACH accepts only the exact canonical id.

Vocabulary pinned from DEX ADR-0013: ten plus-prefixed modifiers (`+LOG +PROVE +AWE +PERF +DEEP +FAST +DRY +NO-REGRESS +MOBILE +SHIP`), five command classes, four mutation levels (`NONE < STAGED < COMMIT < DESTRUCTIVE`), twelve scopes, five trust domains.

### 3.2 Loader behaviour (fail closed)

`loadCanonicalManifest` is a pure function over parsed JSON. It refuses:

- non-object input or a `manifestVersion` that is not semver (`MANIFEST_INVALID`);
- a major other than the pinned major (`DEX_CONTRACT_MAJOR_MISMATCH`, with `expectedMajor` and `actualVersion`), **before** any field validation, so a future major with new fields produces a version refusal;
- unknown keys at either level, a missing field, a name/canonical/slash mismatch, duplicates, an unknown enum value, or a modifier that is not one of the ten (`MANIFEST_INVALID`). Forward-compatible additions require a schema revision, not silent tolerance. Fields that belong to REACH's mapping (`reachOperation`, `invokesReach`) are unknown to DEX entries and are refused there.

### 3.2a Production loading

`production: true` refuses a synthetic manifest or mapping table (`SYNTHETIC_MANIFEST_IN_PRODUCTION`). This is a loader gate only. Nothing in the running node selects it, so the router is inert in production until that wiring is reviewed.

### 3.3 One router, not 50 engines and not 50 tools

- The router is a single lookup, `canonical id -> mapped entry`, followed by the checks in section 5.
- Dispatch reuses the existing operation path (`executeOperation` / `nativeCall`) and its authorization, profile, budget, secret and task-record gates. The router adds no execution path and returns a plan.
- The MCP tool surface does not grow. Exposing a generic command entry point to remote clients is a separate decision that needs its own ADR and an update to the tool-surface invariants.

### 3.4 Modifiers: DEX owns the meaning, REACH enforces monotonicity

DEX ADR-0013 section 6 states the law: a modifier may add requirements or narrow mutation, and may never widen authority. REACH enforces it whatever a mapping says:

- `+DRY` narrows the effective mutation level to `NONE` and requests a preview (DEX `parseDexCommand`: "mutation narrowed to NONE; emit preview only"). On any command it is **accepted**; the plan has `previewOnly: true`, and `reachOperation` is retained only when the mapped operation is a pure read. For any other operation the plan's `reachOperation` is `null` and `previewOf` names the operation it stands in for. A dry run never dispatches a mutation. Every gate (exact node, promotion, acceptance, references) still applies.
  *Amendment:* the first version of this ADR refused `+DRY` on non-read-only commands (`MODIFIER_MUTATION_FORBIDDEN`). That contradicted DEX, which owns the semantic. `MODIFIER_MUTATION_FORBIDDEN` remains in the closed list and is now a defensive refusal for a dry-run plan that would dispatch a mutating operation.
- `+SHIP` grants no authority. The plan records `authorityFromModifiers: false` and `requiresHumanConfirmation: true`.
- `+FAST` cannot skip a gate. The plan records `gatesSkipped: false`.
- `+LOG +PROVE +AWE +PERF +DEEP +NO-REGRESS +MOBILE` add requirements only. They are recorded in `effective.modifiers`, and none changes the node, the operation or the mutation level. Satisfying those requirements is the executing workflow's job.
- `requiresHumanConfirmation` mirrors DEX: the command's mutation level is `COMMIT` or `DESTRUCTIVE`, or `+SHIP` was supplied.

A request modifier must be an exact plus-prefixed DEX modifier, listed in the command's `supportedModifiers`, supplied once. Anything else is `MODIFIER_UNKNOWN`. Lowercase, unprefixed and duplicate forms are refused.

### 3.5 The REACH mapping (owned by REACH)

DEX declares no REACH operation for any command, and no accepted decision grants one. The mapping is therefore a separate, explicit table, `src/shared/dex-reach-mappings.ts`, which **ships empty**. Each entry carries `command`, `authority` (the accepted document granting it), `invokesReach`, `reachOperation`, `product`, `safetyClass`, `dataClass` and `inputOrigin`. Binding refuses (`MANIFEST_INVALID`) a mapping that:

- names a command DEX does not declare, or names one twice, or states no `authority`;
- has `reachOperation` inconsistent with `invokesReach`;
- disagrees with DEX's scope about the product: `product` must be the lowercase product for the eight product scopes, and `null` for `REACH`, `MAINT`, `CONTROL_ROOM` and `GLOBAL`, which are not products;
- carries a `safetyClass` above DEX's mutation level (`NONE` allows only pure reads; an unknown-effect operation needs `DESTRUCTIVE`), or one that contradicts the operation's catalogued safety class;
- weakens a scope floor: a `DROPZONE` command must declare `inputOrigin: dropzone`, and a `PAIR` command must declare PRIVATE or SEALED data until DEX defines a public PAIR contract. Scopes only tighten gates.

Missing contract, precisely: DEX ADR-0013 defines no per-command `invokesReach`, REACH operation, REACH safety class, data class or input origin. Until DEX (or an accepted REACH decision) supplies them, every canonical command is unroutable and the table stays empty. Filling it is a reviewed, evidence-backed change, one command at a time.

## 4. Versioning

- REACH pins `DEX_CONTRACT_MAJOR` (1). A manifest with a different major is refused, and so is a node that advertises a different adapter major.
- Minor and patch differences are accepted only where the schema revision allows them (section 3.2). A newer minor with unknown fields is refused, not ignored.
- DEX commands carry no per-command version, so a caller's `commandVersion` pin is compared with the manifest version (`COMMAND_MAJOR_MISMATCH`). No pin means "the manifest's current version".
- Every refusal is structured: `{ ok: false, code, message, details }`, where `code` comes from the closed list in section 7 and `details` is JSON-serialisable and free of secrets. Refusals never fall back to a different version, node or command.
- A node advertises `dex_command_router: true` and `productAdapters: { <productId>: "<semver>" }` using DEX's lowercase product ids (`DEX_PRODUCT_ADAPTER_VERSION` is `1.0.0`). A missing capability is `CAPABILITY_UNSUPPORTED_ON_NODE`. An adapter major mismatch is `ADAPTER_MAJOR_MISMATCH`. Neither is downgraded to a legacy path, consistent with ADR-0003. Commands in a control-plane scope (`product: null`) need the router capability but no product adapter.

## 5. Exact node selection

Routing a command is a decision about exactly one node. The steps run in order, and the first failure is the refusal:

1. The command must be in the mapped manifest. A canonical command with no mapping is `REACH_MAPPING_ABSENT`; any other id is `UNKNOWN_COMMAND`.
2. For a command that invokes REACH, the request must name `nodeId`. Absence is `NODE_ID_REQUIRED`, even if one node is online.
3. `nodeId` is compared by exact string equality with the enrolled registry. There is no case folding, prefix match, alias, hostname lookup or "primary" default. No match is `NODE_NOT_FOUND`.
4. The node must be enrolled and online. Otherwise `NODE_NOT_ONLINE`. The refusal must not name, suggest or pick another node. This is DEX-INV-001 (ADR-0001 section 4): a task cannot float or migrate.
5. The node must advertise the router capability and, for a product command, the adapter major.
6. Only then are input acceptance (section 6), data class (section 6) and catalogue membership checked.

No step may substitute a different node. A refusal's `details` may name the requested node, never another one. The node remains the final execution authority; this plan authorises nothing by itself.

## 6. Trust boundaries

### 6.1 PAIR PRIVATE/SEALED

- A mapped command whose `dataClass` is `PRIVATE` or `SEALED` is **not** routable from a remote request, and not projectable, unless the request carries a `promotionRef`. Missing promotion is `DATA_NOT_PROMOTED`.
- Promotion is per item, owner-authorized and recorded in an append-only ledger. It is never bulk and never implied by a product's own state. Its record shape is an open question (section 10).
- Search projections and handoff payloads apply the same rule. A handoff whose source is `pair` is refused (`DATA_NOT_PROMOTED`) without a promotion that the product interface verifies.

### 6.2 DROPZONE input

- A command whose `inputOrigin` is `dropzone` is refused (`INPUT_NOT_ACCEPTED`) unless the request carries an `acceptanceRef`. A handoff whose source is `dropzone` is refused until its acceptance is verified.
- Accepted or not, dropzone content is data. It is never parsed as a command, never executed and never used as a routing decision.

### 6.3 WITNESS evidence

- WITNESS is its own evidence trust domain (DEX ADR-0010, ADR-0014 section 3.C). REACH holds WITNESS evidence references in a namespace separate from every other product's state.
- **The WITNESS-to-REMIX edge is forbidden.** The receiver refuses every handoff whose source is `witness` and whose target is `remix` (`WITNESS_REMIX_EDGE_FORBIDDEN`). This check is code, evaluated before receiver acceptance, so no manifest, accepted contract or promotion can re-enable it.

## 7. Refusal codes (closed list)

The closed list has 22 codes. The first 14 were in the original ADR; seven were added by Repair E/F; `REACH_MAPPING_ABSENT` was added by the DEX reconciliation.

`MANIFEST_INVALID`, `DEX_CONTRACT_MAJOR_MISMATCH`, `COMMAND_MAJOR_MISMATCH`, `UNKNOWN_COMMAND`, `NODE_ID_REQUIRED`, `NODE_NOT_FOUND`, `NODE_NOT_ONLINE`, `CAPABILITY_UNSUPPORTED_ON_NODE`, `ADAPTER_MAJOR_MISMATCH`, `INPUT_NOT_ACCEPTED`, `DATA_NOT_PROMOTED`, `OPERATION_NOT_IN_CATALOGUE`, `HANDOFF_INVALID`, `WITNESS_REMIX_EDGE_FORBIDDEN`, `SYNTHETIC_MANIFEST_IN_PRODUCTION`, `MODIFIER_UNKNOWN`, `MODIFIER_MUTATION_FORBIDDEN`, `REFERENCE_VERIFIER_UNAVAILABLE`, `REFERENCE_NOT_FOUND`, `REFERENCE_WRONG_BINDING`, `REFERENCE_REVOKED_OR_INAPPLICABLE`, `REACH_MAPPING_ABSENT`.

A new code requires an ADR amendment. Consumers must treat an unknown code as a refusal.

### 6.4 Promotion and acceptance references are verified, not presence-checked

`promotionRef` and `acceptanceRef` are resolved by an injected `ProductReferenceVerifier`, which is the authoritative product interface. A string that is present proves nothing. Dispatch is refused in every case except a `VERIFIED` answer:

- no verifier, or a verifier that throws or reports `UNAVAILABLE`: `REFERENCE_VERIFIER_UNAVAILABLE`;
- the reference is not held by the product: `REFERENCE_NOT_FOUND`;
- a reference cannot be bound because the request names no target, or the command names no product: `REFERENCE_WRONG_BINDING`, and the verifier is not consulted;
- the reference is bound to another product, command, target, node or data class: `REFERENCE_WRONG_BINDING`;
- the reference is revoked or does not apply to this request: `REFERENCE_REVOKED_OR_INAPPLICABLE`;
- the reference is absent where section 6.1 or 6.2 requires one: `DATA_NOT_PROMOTED` or `INPUT_NOT_ACCEPTED`, and the verifier is not consulted.

REACH does not import another product's database. The verifier is the only route to product state.

## 8. Search projections and handoffs

### 8.1 Search projections are rebuildable only

- A projection is derived from source records, carries a digest of its source, and is marked `rebuildable: true`.
- A projection is never authoritative. Nothing reads a projection as evidence, task state or policy.
- Deleting a projection is always safe. The rebuild is deterministic: identical sources produce an identical projection and digest.
- Projections exclude PRIVATE/SEALED items that lack a promotion (section 6.1). DEX's own `DexSearchDocument` has only `INTERNAL` and `PROMOTED_PUBLIC` visibility; REACH's PRIVATE/SEALED filter is stricter on its own sources and does not depend on DEX emitting those values.

### 8.2 Handoffs are validated by the receiver

A handoff is DEX's `DexHandoffDescriptor`: `{ sourceProduct, sourceObjectKind, targetProduct, targetObjectKind, contractSchema, contractVersion, availability, reason }`. The **receiver** validates it, mirroring DEX `validateHandoffReceiver`:

- the descriptor is closed: an unknown field (`authorized`, `promoted`, `accepted`, `promotionRef`, `acceptedContracts`, ...) is `HANDOFF_INVALID`, so a sender cannot assert authorization;
- `targetProduct` must equal the receiver's product;
- `${contractSchema}@${contractVersion}` must appear in the **receiver's own** `acceptedContracts`; a receiver that lists none accepts none;
- `availability` must be `AVAILABLE`;
- the WITNESS-to-REMIX edge is refused first, in code (section 6.3);
- a `pair` source needs a verified promotion and a `dropzone` source a verified acceptance (sections 6.1, 6.2);
- any failure refuses the handoff and nothing is applied.

The sender's authorization claims are informational. The receiver re-authorizes under its own policy.

## 9. What is implemented now

Implemented, with tests (`tests/dex-contract-adapter.test.ts`, `tests/dex-command-router.test.ts`, `tests/dex-reference-verification.test.ts`), all against synthetic fixtures in the real DEX entry shape:

- the canonical loader and mapping binder (sections 3.1 to 3.5), including major-first ordering;
- routing in section 5 order, sections 6.1 and 6.2 gates, modifier semantics (section 3.4) and verified references (section 6.4);
- receiver-side handoff validation (section 8.2) and the projection filter (section 8.1);
- `scripts/dex-contract-conformance.ts`, run against a real DEX checkout and not part of hosted CI.

Not implemented, deliberately:

- no MCP tool registration and no change to the advertised tool surface;
- no dispatch. The router returns a plan and executes nothing;
- no persistence of routing decisions, promotion ledger or acceptance records;
- no connection to the live registry. The router takes a plain node view;
- no REACH mapping for any DEX command (section 3.5), so every canonical command is unroutable;
- no product behaviour behind the verifier.

## 10. Questions for DEX (status after reading the source)

1. *Authoritative manifest shape.* **Answered by the source:** `DexCommandManifestEntry` in `manifest.ts` (section 3.1). `dex-command-manifest.v1.json` does not exist; ADR-0013 names it a publication target. Open: should DEX publish it, with a stable envelope?
2. *Product ids and semver.* **Answered:** lowercase ids, adapter and manifest version `1.0.0`.
3. *The promotion record* (fields, who may promote, revocation). **Open.** DEX defines `PROMOTED_PUBLIC` visibility but no promotion record or verifier interface.
4. *The DROPZONE acceptance record and who may accept.* **Open.**
5. *The complete WITNESS edge list.* **Open.** DEX forbids WITNESS to REMIX creative edges; REACH enforces exactly that.
6. *Which DEX commands may reach which REACH operation, with what safety class, data class and input origin.* **Open and blocking.** This is the REACH mapping (section 3.5). Without it nothing is routable.
7. *Internal DEX inconsistencies found while reading* (reported, not changed): ADR-0016 lists a `PRIVATE` visibility class and `timestampUtc`, while `productAdapter.ts` has only `INTERNAL`/`PROMOTED_PUBLIC` and `createdAt`; the fixtures under `docs/architecture/control-system/fixtures/` use a third command-manifest shape (`commandName`, `canonicalForm`, `workflowBinding`) that matches neither `manifest.ts` nor ADR-0013's description.

## 11. Consequences

- Positive: one reviewable routing point; the DEX roster can change without REACH code changes while REACH authority cannot grow silently; exact-node and version refusals are testable; trust rules are enforced in code, not left to data.
- Costs: until question 6 is answered, REACH can consume the DEX command language but cannot execute any of it.
- Risk: a mapping that claims an operation REACH does not have is refused at routing, so DEX must not ship commands that depend on unlisted operations without an agreed catalogue change.

## 12. Validation

The synthetic-fixture tests cover: the canonical loader's refusals (every required field, unknown fields, REACH-owned fields smuggled into a DEX entry, scope-as-product, modifier forms, duplicate commands); contract-major refusal before field validation; the production gate; mapping refusals (phantom command, product/scope disagreement, safety above the DEX mutation level, scope floors); an empty shipped table leaving a fifty-command manifest wholly unroutable; inert descriptive fields; `+DRY` preview semantics; `+SHIP` and `+FAST` monotonicity; exact-node selection (missing, case, prefix, offline, not enrolled, no fallback); capability and adapter-major refusals; PAIR, DROPZONE and WITNESS gates; verified references (`tests/dex-reference-verification.test.ts`); receiver-validated handoffs, including forged claims and `acceptedContracts`; and projection exclusion and determinism.

These tests prove REACH's logic against synthetic data. `conformance:dex` additionally proves that the real DEX manifest at commit `57693daa` is accepted by the adapter. Neither proves any DEX product integration.
