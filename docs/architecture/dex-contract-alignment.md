# DEX contract alignment: verification record and open DEX-side decisions

Status: REACH-side adapter implemented. Verified against the real DEX manifest at the commit below. No REACH operation mapping exists, so no DEX command is routable. No change was made to DEX.

## 1. Verification record

Read from `westkitty/DEX` (private; read-only clone kept outside this repository) at commit `57693daafc038e1631bb387819234dd8f9b0647c`, 2026-10-11:

| Item | Status | Evidence |
| --- | --- | --- |
| `packages/router/src/manifest.ts` (manifest `1.0.0`) | READ | SHA-256 `a6b6151223429769bfd2b0eb73412fbc81d7972220e41929f4e11e1ff1219eb5`. 50 commands, 10 modifiers, 12 scopes. |
| `packages/router/src/index.ts` (`parseDexCommand`) | READ | Source of the `+DRY` rule: effective mutation narrows to `NONE`, preview only. |
| `packages/contracts/src/productAdapter.ts` (adapter `1.0.0`) | READ | Lowercase `DexProductId`; `acceptedContracts`; `validateHandoffReceiver`. |
| DEX ADR-0013, 0014, 0016, 0017 | READ (all `Accepted`) | Modifier monotonicity; no REACH runtime dependency; search and provenance; control vocabulary. |
| `dex-command-manifest.v1.json` | DOES NOT EXIST | ADR-0013 names it a publication target. A repository-wide search finds no such file. The authoritative artifact is `manifest.ts`. |
| REACH mapping fields (`reachOperation`, `invokesReach`) | DO NOT EXIST IN DEX | Searched DEX source and docs: none. |
| Conformance run | PASS | `npm run conformance:dex -- --dex-checkout <path>`: loaded under the production gate, `canonicalCount` 50, `routable` 0, `unroutable` 50, all 12 scopes present, modifiers match REACH's pin. |

The conformance run against the live DEX checkout is local evidence; hosted CI cannot reach DEX. Hosted CI instead loads the owner-approved roster snapshot (`tests/fixtures/dex-router/dex-roster-snapshot-v1.json`, identity and classification only; `aliases`, `effect` and `appCommand` blanked; provenance beside it) through the production gate, and runs the behavioural tests against invented `DEX//FIXTURE_*` commands. No DEX source file is stored in this public repository.

## 2. Discrepancies found and how they were resolved

| # | Discrepancy | Resolution |
| --- | --- | --- |
| A | REACH tested a synthetic `FIXTURE//` schema; DEX has a 50-command roster including `DEX//NEXT`. | Tests now use the real `DexCommandManifestEntry` shape. All canonical identities are preserved by the loader (`canonicalCount`, `routable`, `unroutable`); the real 50-command roster is committed as an owner-approved snapshot and checked for drift by `conformance:dex --check-snapshot`. |
| B | DEX has ten plus-prefixed modifiers; REACH modelled three unprefixed ones. | REACH pins all ten, in `+X` form, and refuses unprefixed, lowercase, duplicate or undeclared modifiers. |
| C | DEX entry fields differ from REACH's consumer schema (`invokesReach`, `reachOperation`, `safetyClass`, `dataClass`, `inputOrigin`). | The DEX entry is validated as DEX defines it; REACH-owned fields live in a separate mapping table and are refused inside a DEX entry. |
| D | DEX product ids are lowercase with adapter `1.0.0`; REACH used eight uppercase ids. | REACH uses DEX's lowercase `DexProductId` for adapters, projections and handoffs. |
| E | `+DRY` narrows to `NONE` and previews; REACH refused it on non-read commands. | REACH now follows DEX: accepted on any command, `previewOnly`, `reachOperation: null` for anything but a pure read, every gate still applied. |
| F | Scopes `GLOBAL`, `CONTROL_ROOM`, `MAINT`, `REACH` are not products. | `product` is `null` for those four; they need the router capability but no adapter, and cannot bind a promotion/acceptance reference. |
| G | DEX receivers check versioned `acceptedContracts`. | `validateHandoff` takes DEX's `DexHandoffDescriptor`, is closed against forged claims, and checks the receiver's own `acceptedContracts`. PAIR and DROPZONE sources need a verified promotion or acceptance. |

## 3. Blocking contract gap

DEX declares no REACH operation for any command and no accepted decision grants one, so `src/shared/dex-reach-mappings.ts` ships empty and every canonical command returns `REACH_MAPPING_ABSENT`. Precisely missing, per command that is meant to reach REACH: `invokesReach`, the `reachOperation` in REACH's catalogue, its safety class, the data class and the input origin, plus the document that grants them. REACH must not infer these from a name, scope or workflow id.

## 4. Proposed DEX-side changes (for the DEX owner; not applied)

1. Publish `dex-command-manifest.v1.json` (or an equivalent stable envelope `{ manifestVersion, commands }`) as ADR-0013 intends, so consumers need not import TypeScript source.
2. Decide, per command, whether it invokes REACH, and through which REACH operation, via an accepted ADR that REACH can cite in a mapping's `authority`. Remember DEX ADR-0014 section 2.3: DEX products must not require the REACH runtime.
3. Provide an authoritative reference-verification interface for promotion and acceptance. It must answer `VERIFIED`, `NOT_FOUND`, `WRONG_BINDING`, `REVOKED`, `INAPPLICABLE` or `UNAVAILABLE`, bound to product, command, target, node and data class. REACH does not read DEX's database.
4. Reconcile internal inconsistencies: ADR-0016 lists a `PRIVATE` visibility class and `timestampUtc`, but `productAdapter.ts` has only `INTERNAL` and `PROMOTED_PUBLIC` and `createdAt`; the fixtures in `docs/architecture/control-system/fixtures/` use a command-manifest shape that matches neither `manifest.ts` nor ADR-0013's text.
5. Confirm the complete WITNESS edge list. REACH enforces WITNESS to REMIX only, in code.

## 5. Not done

- No DEX repository change, pull request or issue was made.
- No `dex-command-manifest.v1.json` was generated.
- No REACH mapping was invented for any DEX command.
- No integration with a live DEX product is claimed.
- Only the roster snapshot (identity and classification) is committed, on the owner's approval. DEX source, descriptive prose, aliases and app commands are not.
