# Bounded repository inspection evidence

Date: 2026-10-02. Source and isolated MCP proof passed; installed ChatGPT/Claude experience is **UNVERIFIED**. No installation or persistent-service reload occurred.

Baseline: `935e7a6f0a1fb5e38e7f47045043d9a0cca7dcfe`. Candidate: the commit containing this document on `perf/bounded-performance-pass`, based on that same commit. Canonical `main` remains at `3345b055a0d088869403443c219406590b9fb501`.

## Implemented behavior

Optional `reach_repo_info.inspection` bundles existing repository metadata with typed tree, literal search and line-range reads. Ordinary calls keep their existing behavior. The public interface retains exactly 16 tools in the existing order. All operations still name the exact node, with no fallback.

The persistent node executes the bundle under existing authorization, canonical roots, private-state exclusions, grants, client ceilings, access/profile rules and budget enforcement. Inspection additionally requires `file.read`; logical operation charging accounts for bundled work rather than charging only one unit. Authorization, audits, signed receipts and budget release remain authoritative and awaited. Search patterns are omitted from audit summaries. Inspection bypasses the legacy workspace worker to retain the node's private-state scope.

Ceilings: 8 operations, 16 requested paths, 4 paths and 4 literal patterns per search, 128 characters per pattern, depth 4, 200 tree entries, 100 search matches, 2 context lines, 32 KiB per file, 200 read lines, 16 KiB aggregate JSON result, and 5 seconds. Runtime traversal is capped at 1,024 visited entries, 64 scanned files and 256 KiB scanned bytes. Oversized requests/results fail; bounded prefix/count results report truncation. Symlinks, private state and excluded generated/vendor/credential paths cannot widen reads. Binary content is not returned as text; credential-like text and known environment secrets are redacted. This is not a generic secret detector.

The result context carries exact node ID, repository root, branch and observation time. It is advisory, non-atomic and does not replace selection, authorization or fresh plan/commit fingerprint checks. Files may change during an inspection.

## Matched real MCP measurement

The existing isolated gateway/node harness used temporary state, canonical temporary workspace paths, unique explicit node IDs, loopback ephemeral ports and real OAuth-authorized MCP Streamable HTTP. Only disposable test nodes were configured read-only. Coordination requirements remained active. Cleanup stopped only proof-created processes.

The same three tracked files (468 UTF-8 bytes) supplied metadata, one depth-2 tree, two literal searches and three six-line reads. One discovery per version and initialization were excluded from workflow timing. After one warmup per version, five measured workflows per version alternated execution order. Time used client monotonic elapsed time.

| Metric | Phase 1 baseline | Inspection candidate |
| --- | ---: | ---: |
| Calls per complete intent, all five samples | 9 | 1 |
| Serial client await boundaries | 9 | 1 |
| Median complete workflow time | 461.418 ms | 68.579 ms |
| Median returned UTF-8 text bytes | 3,979 | 5,505 |
| Result continuation calls | 0 | 0 |

The baseline actually performed repo info, directory listing, two search starts, three reads and two search-result retrievals. No repeated discovery was invented. Search retrieval is part of completing the searches, not large-result continuation. Equivalent repository fields, file listings, matching file/line/token evidence and full ranged-read lines were asserted. The candidate additionally returns complete search lines. Receipt chains verified; unknown-node and scope refusals were exercised.

Calls fell 88.9% and median workflow time fell 85.1%; response text grew 38.4%. Bytes measure returned tool text, excluding transport framing. This small fixture/sample establishes call collapse and isolated workflow timing, not general repository performance, reliable tail latency, measured model reasoning savings or automatic client adoption.

Raw observations and individual routed times: [PERFORMANCE_PHASE2_TIMING.json](PERFORMANCE_PHASE2_TIMING.json). Reproduction: [proof-repo-inspection.ts](../scripts/proof-repo-inspection.ts), using installed lockfile dependencies in both candidate and a separate baseline checkout at the exact baseline SHA:

```sh
node --import tsx scripts/proof-repo-inspection.ts --baseline /absolute/path/to/phase1-checkout --out /absolute/path/to/evidence.json
```

## Validation

All commands ran from the candidate checkout; final exits were captured.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Exit 0 |
| Focused tests listed below | 89/89 passed; exit 0 |
| Isolated matched benchmark above | Exit 0; equivalent evidence and signed chains passed |
| `npm run verify` | Exit 0; 42 invariants, 288/288 tests, build, zero production vulnerabilities and backend probe passed |
| `git diff --check` | Exit 0 |

Focused command:

```sh
node --test --import tsx tests/repo-inspection.test.ts tests/mcp-contract.test.ts tests/native.test.ts tests/security.test.ts tests/operations.test.ts tests/access.test.ts tests/audit.test.ts tests/workspace-worker.test.ts tests/budget.test.ts tests/routing.test.ts
```

Coverage includes legacy fields, tool ordering, exact-node routing, malformed requests, root/repository/symlink/private-state exclusions, all schema/runtime bounds, read-only non-mutation, grants/budgets, audit redaction, deterministic evidence and timeout cancellation. One source repair corrected TypeScript narrowing before the passing gates. Proof setup/parser corrections did not change security behavior.

Affected files: gateway MCP schema; node request/native execution; new shared inspection schema and node inspector; capability, budget, audit and workspace-worker boundaries; focused tests; benchmark script; README and operational/evidence documentation. No dependencies, public tools, transport, receipt algorithms, keys, installed policy or private runtime state changed. Unrelated Python cache remains preserved.

## Deferred and release boundary

Receipt chain-head and parsed Ed25519 key caching were evaluated and deferred. Current predecessor recovery rereads the authoritative receipt log. A safe replacement needs separate crash/restart, stale-head, concurrent append and tamper recovery proof, plus key-identity invalidation. This patch retains existing receipt guarantees.

Source implementation and isolated MCP acceptance passed. Installed ChatGPT/Claude experience, hosted CI and model reasoning-time savings remain unverified. Deployment recommendation: review this branch, then authorize a coordinator-mediated installation and real installed-client acceptance separately. This task performs no deployment.
