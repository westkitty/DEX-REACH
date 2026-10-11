# DEX contract alignment: verification record and DEX-side change proposal

Status: REACH-side adapter implemented and fixture-verified. DEX-side contract NOT verified. No change made to DEX.

## 1. Verification record

| Item | Status | Evidence |
| --- | --- | --- |
| `westkitty/DEX` repository | UNREACHABLE from this environment | Clone, `gh api` and `git ls-remote` return HTTP 403 (recorded in the correction session). |
| `dex-command-manifest.v1.json` | NOT VERIFIED: existence unknown | It cannot be read because DEX is unreachable. It was not generated, copied or invented. |
| DEX ADRs 0013, 0014, 0016, 0017 | NOT READ | Same cause. ADR-0004 section 10 questions remain open. |
| REACH router and adapter | Fixture-verified | `tests/dex-command-router.test.ts` (18), `tests/dex-contract-adapter.test.ts`, `tests/dex-reference-verification.test.ts`. |

Consequence: REACH's contract is a versioned consumer schema (ADR-0004 section 3.1) tested against a synthetic fixture (`tests/fixtures/dex-router/command-manifest.synthetic-v1.json`, `synthetic: true`). The fixture's command names are not DEX's roster. Real DEX data must be loaded only through `loadCommandManifest` with the production gate enabled.

## 2. Discrepancy to record

- REACH cannot confirm that DEX publishes a manifest of this shape. Any field name in ADR-0004 section 3.1 that DEX does not use is a discrepancy until DEX answers section 10.
- The 50 command names, their modifiers, scopes and workflows are DEX-owned. REACH holds none of them and generates no per-command engine or MCP tool.
- The production loader option only refuses synthetic manifests. Nothing in the running node currently selects it.

## 3. Proposed DEX-side changes (for the DEX owner to decide; not applied)

1. Per command, declare `invokesReach` (boolean). Declare `reachOperation` only when it is `true`, and name only an operation that REACH catalogues. A command that does not invoke REACH must not carry a REACH target.
2. Per command, declare `modifiers` drawn from `DRY`, `SHIP`, `FAST`. DEX owns their meaning. REACH enforces monotonicity regardless: `+DRY` never mutates, `+SHIP` grants no authority, `+FAST` never skips a gate.
3. Provide an authoritative reference-verification interface for `promotionRef` and `acceptanceRef`. It must answer one of `VERIFIED`, `NOT_FOUND`, `WRONG_BINDING`, `REVOKED`, `INAPPLICABLE` or `UNAVAILABLE`, bound to product, command, target, node and data class. REACH does not read DEX's database.
4. Publish the manifest with `contractVersion` semver. REACH refuses any major other than its pinned major with `DEX_CONTRACT_MAJOR_MISMATCH`, before field validation.
5. A published manifest must not set `synthetic: true`.
6. Answer ADR-0004 section 10 questions 1 to 6, including the complete WITNESS edge list. The WITNESS-to-REMIX prohibition holds in REACH regardless of DEX's answer.

## 4. Not done

- No DEX repository change, pull request or issue was made.
- No `dex-command-manifest.v1.json` was generated.
- No REACH `reachOperation` mapping was invented for any DEX command.
- No integration with a live DEX product is claimed.
