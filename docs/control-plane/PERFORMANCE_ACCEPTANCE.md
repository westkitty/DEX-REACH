# Matched performance acceptance

Use the existing `scripts/proof-repo-inspection.ts`; retain baseline/candidate contracts, exact node identity, security/admission policy and equivalent complete intent. Freeze revisions before the run; bind lockfiles, hardware, operating system and runtime. Record source modifications separately. A documentation commit containing evidence is not the revision measured.

Record calls, serial await boundaries, returned UTF-8 text bytes, elapsed distributions, continuation calls, resource measures when available, equivalence and refusal/receipt results independently. Never infer installed-client adoption, token billing or model reasoning-time savings from tool timing. Tiny fixtures and five samples do not establish reliable tail latency or general repository performance.

## Fresh matched observation — October 4, 2026

Baseline `935e7a6f0a1fb5e38e7f47045043d9a0cca7dcfe`; measured canonical candidate `5da188b56650f8c8eb02efbdc0566afc1803eb1f`. Baseline was clean; canonical source was unchanged and only unrelated maintenance Python cache was initially untracked. Cached main/origin-main divergence was 0/0; no remote fetch or publication was performed.

Same MacBookAir10,1 (Apple M1), 8 logical CPUs, 8 GiB memory; macOS 26.6.2 build 25G83; Node.js v26.9.0. Package lockfiles were byte-identical. Exact baseline tracked source was exported with `git archive` into task scratch, with a symlink to the same installed dependencies used by the candidate. The source baseline/worktree was not edited.

The unchanged existing harness created temporary state, loopback ephemeral ports, two disposable gateway/node pairs and real OAuth-authorized MCP clients. It configured only disposable nodes read-only and preserved coordination requirements. No model or weight loads, installation or persistent runtime restarts occurred. Three tracked fixture files total 468 UTF-8 bytes; each complete intent includes repository info, depth-2 tree, two literal searches and three six-line reads. Initialization and one discovery per version are excluded. One warmup per version precedes five measured workflows per version with alternating order.

| Dimension | Baseline | Current candidate |
| --- | ---: | ---: |
| Calls per complete intent, all five samples | 9 | 1 |
| Serial client await boundaries, all five samples | 9 | 1 |
| Median complete workflow elapsed | 331.695 ms | 42.391 ms |
| Median returned text bytes | 3,979 | 5,505 |
| Result continuation calls | 0 | 0 |

Equivalent repository fields, tree entries, matching file/line/token evidence and complete ranged reads passed. Signed receipt chains, explicit unknown-node refusal, scope refusals and audit pattern omission passed; harness exit 0. The call and elapsed reduction carries a payload increase of 1,526 bytes per median response. The fixture supplies no measured resource, installed-client, model-time or billing result.

[Raw observations and binding](PERFORMANCE_2026-10-04.json) preserve each sample/routed call. The harness's historical `candidateBase` literal names its original base, not the currently measured commit; `runBinding.candidateRevision` identifies this run. This distinction prevents a stale embedded field from silently changing the target claim.

The first launch failed because its baseline cwd pointed to the intended task scratch before the export had been moved there. The scratch path was corrected; the unchanged harness then passed. No product-code workaround was applied. Cleanup belongs to the existing harness and stops only its proof-created process groups/state.

Reproduce from the candidate with the exact baseline export/dependencies available:

```sh
node --import tsx scripts/proof-repo-inspection.ts --baseline /absolute/path/to/exact-phase1-checkout --out /absolute/path/to/evidence.json
```

Installed ChatGPT/Claude adoption and ordinary-client latency remain **UNVERIFIED**. No source regression suite was rerun for this documentation-only change; the benchmark independently executed its embedded correctness/security assertions. Historical validation stays in `../PERFORMANCE_PHASE2.md` and is not relabeled as today's proof.
