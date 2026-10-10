# C14 DEX ecosystem conformance matrix

## Scope

This is a read-only contract comparison between the current REACH source and
the private `westkitty/DEX` repository. No DEX checkout was modified. The local
`/Users/andrew/DEX-REACH` checkout was dirty with unrelated work and was
preserved; the canonical DEX repository was inspected through read-only GitHub
API responses.

Observed DEX main commit at inspection: `57693daafc038e1631bb387819234dd8f9b0647c`.
Relevant authority includes `CONTRACT_REGISTRY.md`, `VALIDATION_CONTRACT.md`,
`COMMAND_ROSTER.md`, ADR-0010, ADR-0011, ADR-0014, the product manifests, and
negative privacy/provenance fixtures.

## Contract matrix

| Boundary | DEX contract | REACH consumer/evidence | State | Required proof or implication |
| --- | --- | --- | --- | --- |
| Versioned product adapters | `DexProductAdapter` v1.0.0; products remain standalone and expose safe status/control/handoff/search/provenance adapters | No `DexProductAdapter` implementation or DEX product adapter import exists in this REACH branch; REACH exposes its own MCP/node contract | NOT IMPLEMENTED | A future integration must consume the typed adapter contract without private-state access |
| PAIR PRIVATE/SEALED | Private/sealed data requires explicit promotion; unpromoted content is excluded from global search | No PAIR consumer or cross-product serializer exists in REACH; REACH source has no PAIR payload path | IMPLEMENTED_UNVERIFIED at ecosystem level | Synthetic DEX negative fixture exists; REACH integration test is not applicable until a real consumer exists |
| DROPZONE trust | Quarantined/unaccepted input cannot be indexed or executed; accepted handoff is versioned and receiver-validated | No DROPZONE consumer or intake execution path exists in REACH | IMPLEMENTED_UNVERIFIED at ecosystem level | Do not add automatic acceptance; future adapter must validate receiver contract and preserve quarantine |
| WITNESS firewall | WITNESS is a separate evidence trust domain; WITNESS-to-REMIX creative mutation edge is forbidden | REACH has evidence/receipt/trace contracts but no WITNESS product integration or creative mutation path | IMPLEMENTED_UNVERIFIED at ecosystem level | Evidence integrity is not proven across products until a real versioned adapter is exercised |
| CAPSULE/MUSEUM/REMIX/SIDEQUEST/SESSION | Products own state and remain independently runnable; cross-product movement uses versioned exports/references | No REACH source consumer of these product adapters was found | NOT IMPLEMENTED | No product runtime claim is made; future integration must not create shared mutable storage |
| Provenance/search projections | Derived, rebuildable safe projections; no restricted bodies, unaccepted uploads, or unapproved evidence | REACH has node/task receipts, trace and bounded result projections, but not DEX product projections | IMPLEMENTED_UNVERIFIED | Existing REACH privacy tests cover REACH artifacts only, not DEX product payloads |
| Control vocabulary | DEX manifest defines 50 canonical commands, including `DEX//NEXT`; modifiers are monotonic | REACH source has 16 MCP actions and compatibility tools, not the DEX 50-command router | NOT IMPLEMENTED | Do not fabricate a 50-engine surface; integration requires the DEX manifest/adapter contract |
| Cross-repository versioning | Contract registry requires semantic versions, major-version pinning, six-month deprecation, and structured mismatch errors | REACH ADR-0003 is the relevant protocol contract; current source is Protocol v1 with capability metadata, while DEX registry expects v2.0 contract | PARTIAL | Owner must decide whether to implement genuine v2 dual-stack or narrow a release to v1 explicitly |
| Runtime independence | DEX products must run without a REACH runtime dependency; REACH remains a separate control plane | Current source and local tests preserve REACH node authority and do not reach DEX product state | VERIFIED for separation | This is the current safe boundary; no cross-product runtime conformance is claimed |

## Test evidence

DEX’s own repository contains contract tests and negative fixtures for product
adapters, PAIR private/unpromoted search, DROPZONE unaccepted search, and the
WITNESS-to-REMIX forbidden edge. Those tests prove DEX contract behavior in the
DEX repository. They do not prove a REACH integration that does not exist.

REACH’s current relevant evidence is limited to its own exact-node routing,
policy, result, receipt, trace, privacy projection, and capability-adapter
tests. No new REACH fixture was added because no implemented DEX consumer seam
was found; adding a synthetic cross-product implementation would create a
false integration surface.

## Verdict

The ecosystem boundary is **PARTIAL / IMPLEMENTED_UNVERIFIED**, not failed:
the source preserves product independence and the DEX contracts are explicit,
but REACH-to-DEX conformance is not an implemented runtime surface on this
branch. Required future evidence is a versioned adapter/serializer contract,
synthetic positive and negative cross-product tests, and any authorized
integrated E2E. No private product content was copied into this report.
