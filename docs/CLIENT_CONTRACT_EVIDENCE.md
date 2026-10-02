# Public gateway versus hosted-client contract — 2026-10-02

## Current independent evidence

Source started at synchronized canonical `main` / `origin/main` `b236cc6791b8c35d155b43afe15a8772eb1fdfba`. Source registration is `src/gateway/mcp.ts`, instantiated by the authenticated `/mcp` path in `src/gateway/main.ts`. Exactly 16 public tools are registered; node compatibility discovery is separate and retains 22 safe tools (26 raw local tools). No legacy public registration path was found. Existing exact-name/order regression and live smoke reject extra public tools.

Current Codex tool inventory independently contains 12 `DEX__REACH` and 16 `DEX__REACH_Refresh` entries. Fresh public OAuth discovery returns exactly the intended 16 names in order and optional inspection. Both connector namespaces reach the selected physical node; the refreshed connector executes the six-operation inspection. The installed old gateway registration and inspection modules were byte-identical to the validated main build. Thus the 12+16 duplication is in hosted integration advertisement downstream of the gateway. Separate app registrations/snapshots are the supported explanation; hosted admin records and endpoint mappings are not available to establish their precise history. No API renaming or compatibility retirement is justified.

The old runtime release was tied to `d5a06e2` and dirty status. The runtime ID implementation includes untracked files, and the preserved Python cache explains a current canonical-checkout dirty ID. This is correct provenance, not a string to suppress. The supported installer ran from a clean Git worktree using existing dependencies and installed `0.3.2-b236cc6791b8-1b94c7ca6c94`. Receipt completed `2026-10-02T14:28:43.955Z`; four services ran, OAuth canary exited 0, health was `ok:true` with exactly one online node. All 126 compiled JavaScript files matched main. Policy, enrollment settings and secrets matched pre-install hashes. This documentation-only publication is followed by final installation from its containing main commit; active exact revision is recorded in LaunchAgent runtime paths, not a self-referential hash in this document.

Real refreshed-connector invocation wall time: **2,048 ms**. Fresh public OAuth-client operation time before deployment: **164.263 ms**; the post-install public call passed in **620.361 ms**. Each returned metadata, one tree, two literal searches and three ranged reads, **7,547 UTF-8 text bytes** under the requested 12,000-byte limit. Context matched explicit node/root/main and `advisory:true`, `selectionRequired:true`, `snapshotAtomic:false`. These measure distinct client paths, not model latency or a benchmark distribution. Existing read-only contract tests cover routing, optional schema, malformed operations and bounded inspection failures.

| Required command | Current result |
| --- | --- |
| Focused MCP/inspection/runtime tests | Exit 0; 22/22 |
| `npm run typecheck` | Exit 0 |
| `npm test` | Exit 0; 288/288 |
| `npm run build` | Exit 0 |
| `npm audit --omit=dev --audit-level=high` | Exit 0; 0 vulnerabilities |
| `npm run probe:backend` | Exit 0; 26 raw tools |
| `npm run smoke` | Exit 0; 16 public / 22 safe compatibility tools |
| `npm run invariants -- --check` | Exit 0; 42 invariants |
| `npm run smoke -- --contract-only --node macbook-air.local --cwd /Users/andrew/DEX-REACH` | Exit 0; exact schema/list, legacy compatibility and bundle |

## External retirement action

**BLOCKED/EXTERNAL for removal of the legacy namespace.** This session has no hosted connector administration or registration refresh capability. The namespace remains present; no client-side fix is claimed.

An authorized workspace admin must inspect the two existing app registrations, retain the intended `DEX__REACH_Refresh` app and retire/unpublish the obsolete `DEX__REACH` app (or disable its selection for this user). Refreshing only the old snapshot could yield duplicate 16-tool surfaces rather than one surface. Preserve the retained app's existing access/action controls; do not rotate credentials or alter node enrollment/policy.

If retained-app metadata needs an update, OpenAI currently documents Enterprise/Edu **Workspace settings → Apps → Action control → Refresh**, followed by review of new actions and schema changes; new actions default disabled. Published Business apps require recreation and republication. This is a hosting-layer operation, not a DEX deployment fix. [Official OpenAI documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt), retrieved 2026-10-02.

After the applicable admin action, a genuinely fresh ChatGPT conversation must independently observe only the intended 16-tool namespace, optional inspection and a successful bounded call. A Codex connector inventory proves this session's advertised surface; it is not an observation of a fresh ChatGPT UI. If admin records show a different endpoint for the legacy app, correct or retire that registration rather than assuming a shared cache.

## Prior verification record (historical; superseded above)

# Public gateway versus hosted-client contract — 2026-10-02

**NOT COMPLETE for fresh ChatGPT exposure or full-suite validation.** Focused source contract tests, installed inspection execution and fresh public-gateway discovery are verified. The hosted app's advertisement has not been updated or observed in a genuinely fresh ChatGPT session from this repair. Full-suite failures remain visible below.

## Located mismatch

Canonical `main` was `25929450f81463686592602a4f08ec87c85c4146`, with only the unrelated DEX//MAINT Python cache untracked before edits. Source and contract tests define these exact 16 tools, in order:

```text
reach_list_nodes reach_list_tools reach_call reach_fingerprint
reach_trust_report reach_repo_info reach_adb_devices reach_checkpoint
reach_file_read reach_file_write reach_process_run reach_plan
reach_commit_plan reach_receipts reach_result_read reach_revoke_node
```

Registration has one runtime definition path: `src/gateway/mcp.ts`, called by `src/gateway/main.ts` for each authenticated MCP session. No separate connector manifest or generated tool registry participates in that gateway path. The macOS installer compiles source directly into an immutable private release before updating LaunchAgents. It does not advertise tools independently.

All four installed LaunchAgents pointed to `0.3.2-d5a06e2bc259-1b94c7ca6c94-dirty-1790940355904`; their processes were present. The installed gateway's compiled module contains the 16 registrations and optional inspection schema. Loopback health returned one online node. The release name identifies a source revision plus dirty marker; it is not a clean exact-byte attestation to current HEAD. The two newer main commits are documentation changes. No release replacement was performed.

A genuinely new OAuth-authorized MCP client session at the public endpoint returned all 16 names in order, optional `inspection` and the read-only annotation. The current Codex connector inventory exposes only the reported older 12 names, missing `reach_trust_report`, `reach_plan`, `reach_commit_plan` and `reach_receipts`. The user's fresh ChatGPT observation also reports 12 and an older repo-info input. This isolates the mismatch downstream of live gateway discovery; the precise hosted registration/action-control record cannot be inspected through this session's tools.

The evidence is consistent with OpenAI's documented approved workspace tool/input snapshot, which survives new conversations and does not automatically consume server updates. Optional additions may still execute successfully against the live backend. [OpenAI's documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) describes the update mechanism. This is the required external layer to inspect/update, rather than duplicating registrations or weakening server contracts.

## Scoped changes

- `tests/mcp-contract.test.ts`: explicitly require the advertised inspection property, retain optionality/read-only/exact-name/order checks, and submit one tree, two literal searches and three reads through the served schema. Assert one route to the supplied node; malformed operations still fail without routing. Existing native inspection regressions preserve legacy output and safety bounds.
- `scripts/smoke.ts`: tighten the existing public contract check to exact names/order and optional inspection. Add `--contract-only --node <exact-id> --cwd <absolute-DEX-source-root>` to reuse the existing fresh OAuth client without the ordinary smoke's mutation fixtures. No new runtime/public tools, dependency, installer logic or authority changes.
- `README.md`, `OPERATIONAL_STATE.md`, this evidence: distinguish the active gateway from hosted metadata, correct the superseded current runtime description, and document the reproducible proof and external update step.

## Installed action proof

```sh
npm run smoke -- --contract-only --node macbook-air.local --cwd /Users/andrew/DEX-REACH
```

Exit 0. Public endpoint: `https://macbook-air.tailafb7e8.ts.net`. Exactly 16 tools; inspection present and optional; read-only annotation true. A legacy call retained `root`, `branch`, `remote`, `status`, `log`. The bundle returned metadata, tree, two searches and three ranged reads in **148.983833 ms**, **7,634 returned UTF-8 text bytes**, below its requested 12,000-byte aggregate limit. Context contained exact node `macbook-air.local`, root `/Users/andrew/DEX-REACH`, branch `main`, `advisory:true`, `selectionRequired:true`, `snapshotAtomic:false`. Time is client monotonic elapsed time for one live call, not a benchmark distribution or model latency measurement.

An earlier temporary proof reusing the same OAuth implementation independently returned the same discovery contract and a bundle in 186.051125 ms. Source tests and advertised schema preserve the existing hard bounds. Neither proof changed owner access/profile/roots/grants or restarted a service. Normal authentication and authoritative audit/receipt handling remained active.

## Validation

Focused command: `node --test --import tsx tests/mcp-contract.test.ts tests/repo-inspection.test.ts tests/runtime-release.test.ts` — **22/22 passed**, exit 0.

| Command | Final result |
| --- | --- |
| `npm run verify` | Exit 1: typecheck and 42 invariants passed; 287/288 tests passed; worker restart socket readiness failed. The chain stopped before build/audit/backend. |
| `node --test --import tsx tests/workspace-worker.test.ts` | Exit 0; 3/3 passed alone. |
| `npm test -- --test-concurrency=2` | Exit 1; 287/288 passed. Worker passed; the short-lived OAuth refresh/recovery test failed with `invalid or expired access token`. Its fixture uses an 80 ms access-token lifetime. |
| `npm run build` (separate command) | Exit 0. |
| `npm audit --omit=dev --audit-level=high` | Exit 0; zero vulnerabilities. |
| `npm run probe:backend` | Exit 0; 26 raw compatibility tools. |
| Read-only `npm run smoke` command above | Exit 0. |
| `git diff --check` | Exit 0. |

The bounded-concurrency retry was an alternative to process-start contention, not a weakened assertion/timeout. Neither timing fixture nor authorization implementation was changed. No third broad retry or unrelated source repair was attempted. Full-suite validation is **FAIL / NOT COMPLETE**, even though focused contract checks and live read-only action proof pass. The smallest next source-validation tranche is deterministic worker-readiness and OAuth-clock regression work; those fixtures should be repaired with their actual failure evidence before repeating the full suite.

## Remaining external step

Inspect the existing hosted app's approved actions/input snapshot and endpoint as a workspace admin. Enterprise/Edu: Workspace settings → Apps → Action control → Refresh, then review the new actions (disabled by default) and changed schema under existing controls. Published Business app: OpenAI currently documents recreation and republication to update tools/metadata. Do not silently enable actions or alter access policy. After the applicable authorized update, open a genuinely fresh ChatGPT conversation and verify the exact 16 names plus optional inspection, then run the bounded read-only bundle. If the snapshot is already current, investigate hosted action filtering/endpoint selection rather than assuming a cache.

No admin update, publication, deployment, commit or push was performed. Prior Git authority applied to the performance branch, not this new canonical-main repair. The reviewable diff remains uncommitted; unrelated Python cache is preserved. Fresh ChatGPT exposure and refreshed Codex connector exposure remain **UNVERIFIED**. No installation is recommended to correct a gateway contract that already passes.
