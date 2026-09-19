# DEX//REACH Protected Capability Invariants

These are release-blocking behavioral invariants, not aspirations. Each entry states what must remain true, what evidence is acceptable, and when the invariant must be rechecked. `src/shared/invariants.ts` is the machine-consumable ID index; `npm run invariants` emits it as JSON, and regression tests require its ID set to stay synchronized with this document.

| ID | Protected capability | Preconditions / action | Expected result | Acceptable proof | Current proof state | Recheck trigger |
| --- | --- | --- | --- | --- | --- | --- |
| DEX-INV-001 | Explicit machine selection | Any remote operation | Exact `node_id` is required; blank/unknown/offline/revoked IDs fail and never fall back | Routing regression test + live `reach_list_nodes`/targeted call | Verified | Routing, registry, MCP, enrollment changes |
| DEX-INV-002 | Node-local owner authority | Node OFF/READ-ONLY/ON, timed mode, client ceiling, grants | Node applies the latest local policy immediately before execution; a remote client cannot increase authority | Access concurrency tests + deployed policy refusal | Verified | Policy, grants, reservation, routing changes |
| DEX-INV-003 | Fail-closed policy | Policy absent/corrupt | Effective access is OFF; policy check reports invalid state | Access regression tests + `npm run dex -- policy-check` | Verified | Policy schema/persistence changes |
| DEX-INV-004 | Filesystem scope | Native/compat path request including symlink, plural/nested/camelCase path fields | Path resolves inside configured roots and outside DEX private state, or request is refused | Security/native tests + live compatibility smoke | Verified | Path parser, native FS, compatibility schema changes |
| DEX-INV-005 | Compatibility configuration stays node-owned | Remote compatibility call | Safety config, local call-history, vendor feedback/onboarding tools are not remotely advertised/invocable; URL proxy reads fail | Backend filtering tests + deployed 22-tool smoke | Verified on deployed 0.3.2 golden worker; PROOF STALE after the MCP SDK v2 migration; source-level contract tests pass but the deployed smoke has not rerun | Backend package/version/tool-surface changes |
| DEX-INV-006 | READ-ONLY is shell-free | READ-ONLY process or compatibility request | No arbitrary shell parsing, chaining, redirection, substitution, write tool, or unknown compatibility tool executes | Security/access tests + real refusal path | Verified | Command parser/profile/tool allowlist changes |
| DEX-INV-007 | ON/full-local limits are represented honestly | Enabled shell execution | Requested cwd is root-scoped and command guards apply, but docs never claim OS filesystem sandboxing | README/SECURITY review + native tests | Verified | Shell/executor/sandbox changes |
| DEX-INV-008 | Process children do not inherit credentials | Any native or compatibility subprocess | DEX node token/owner password/env-file and obvious secret-bearing env vars are absent; known parent secret values are redacted from returned output | Native regression test + deployed `env` smoke | Verified on deployed 0.3.2 golden worker | Child-process/backend environment changes |
| DEX-INV-009 | Remote transport protects credentials | Public/non-loopback gateway identity or node WebSocket | Public MCP identity uses HTTPS; remote node transport uses WSS; cleartext WS/HTTP allowed only for loopback development | Config regression tests | Verified; PROOF STALE after the MCP SDK v2 migration; source-level contract tests pass but the deployed smoke has not rerun | Gateway/node config changes |
| DEX-INV-010 | Exact plan executes at most once | Create then concurrently commit a consequential plan | Exactly one claimant; client/policy/request/expiry must still match; stored raw args scrub after claim/expiry | Plan concurrency/expiry tests + public plan→commit smoke | Verified | Plan storage/commit changes |
| DEX-INV-011 | Receipts are signed and linear | Concurrent node execution receipts | Each receipt signature/hash verifies and predecessor relation forms one chain without raw request/result contents | Receipt concurrency/tamper tests + public receipt smoke | Verified after repairing a reproduced stale-lock recovery TOCTOU; 5 focused lock/receipt stress runs, 3 complete post-fix regression runs, and the final golden worker passed | Receipt/key/storage changes or any recurrence |
| DEX-INV-012 | Concurrent owner/state writes do not lose authority | Competing policy, grant, revocation, credential, OAuth, or bootstrap writers | Atomic/locked update preserves latest authorized state; stale writers cannot roll it back | Access/auth/revocation/bootstrap regression tests | Verified | State persistence changes |
| DEX-INV-013 | Credentials are independent and revocable | Rotate/revoke/forget one node | Other nodes remain unaffected; revoked node cannot reconnect; clean re-enrollment is possible only after owner forget/re-enroll flow | Node-auth tests + prior live rotation/revocation proof | Verified | Registry/node-auth changes |
| DEX-INV-014 | Public source grants no runtime authority | Clone/read public repository | No gateway/node credential, policy, enrollment file, private key, or deployment secret is present or inferred as authority | Git secret/path review + architecture | Verified for inspected tree | Any commit touching config/auth/deployment artifacts |
| DEX-INV-015 | Persistent self-update survives transport replacement | Run macOS install from DEX itself | Installer returns before gateway/node replacement; one-shot helper cycles services once; node reconnects; no restart loop | Live `install:macos` status + PID stability window | Verified | macOS installer/service lifecycle changes |
| DEX-INV-016 | Dock launcher is a recovery/control surface, not an authority escalator | Click `DEX REACH.app` | New Terminal instance opens DEX control console; launch alone does not alter access mode, ceilings, grants, credentials, roots, or profile | Signed bundle/Dock URL/process/Terminal-content proof + policy comparison | Verified; final post-build reproof pending | Launcher/console/install changes |
| DEX-INV-017 | Public MCP surface is exactly the intended contract | OAuth/PKCE client lists tools | 16 first-class tools with metadata; deployed node version matches source; safe compatibility surface matches expected count | `npm run smoke` | Verified on deployed 0.3.2 golden worker; PROOF STALE after the MCP SDK v2 migration; source-level contract tests pass but the deployed smoke has not rerun | MCP/tool/version/auth changes |
| DEX-INV-018 | ADB availability is not faked | Deployed node runs ADB discovery | `available:true` only when `adb` actually launches; no attached device is not reported as tool unavailability | Live `reach_adb_devices` + public smoke | Verified on primary Mac | Service PATH/ADB integration changes |
| DEX-INV-019 | Simulation stays labeled simulation | Isolated second-node tests | No statement upgrades simulated process evidence into separate-hardware proof | Operational State/README review | Verified | Documentation/release claims |
| DEX-INV-020 | Planned mutations bind execution identity | Create an exact mutation plan, optionally with expected identity, then commit | Planning refuses mismatched expected identity; successful plans store a fresh execution fingerprint/hash; commit refuses if machine/user/cwd/repository/branch/remote/runtime identity drifted | Execution-identity regression tests + deployed rejected-identity, branch-drift refusal, and plan→commit smoke | Verified on deployed 0.3.2 golden worker | Plan schema, fingerprint, commit, repository identity changes |
| DEX-INV-021 | Live trust reports remain evidence-scoped | Request `reach_trust_report` | Report includes fresh fingerprint, owner access state, live checks, invariant IDs, and certificate hash; PASS applies only to listed live checks and explicitly does not claim full release proof | Trust regression test + deployed trust-report smoke + docs review | Verified on deployed 0.3.2 golden worker; PROOF STALE after the MCP SDK v2 migration; source-level contract tests pass but the deployed smoke has not rerun | Trust report, invariant manifest, policy, compatibility surface, transport changes |
| DEX-INV-022 | Machine workload admission grants no execution authority | Hold any coordinator lease, then request an operation | Owner mode, client ceilings, grants, roots, profile and plan rules decide the request exactly as they would with no lease; a lease record carries no capability, grant, root, token or mode field | Coordinator regression tests (lease field set, authorization parity with and without a lease) | Verified by regression only; not yet exercised on the primary Mac | Coordinator, access, capability, or CLI admission changes |
| DEX-INV-023 | Repository mutation ownership is exclusive | Two agents request `mutate` or `exclusive` on one repository root | Exactly one holds the lease; the second is queued, and a different spelling or symlink of the same root resolves to the same holder | Coordinator concurrency tests | Verified by regression only; not yet exercised on the primary Mac | Coordinator lease or repository-canonicalization changes |
| DEX-INV-024 | Exhausted machine capacity queues rather than oversubscribes | Substantive slots, heavy slots, live memory/CPU/thermal pressure, or corrupt coordinator state | Additional substantive work receives a FIFO queue ticket; a host at or under 12 GiB yields one substantive slot; degraded coordinator state falls back to single-substantive-job mode rather than unlimited admission | Capacity and coordinator regression tests | Verified by regression only; host probes exercised against recorded fixtures, not against the primary Mac | Capacity policy, platform probe, or coordinator admission changes |
| DEX-INV-025 | Stale coordination state is reclaimed without terminating processes | Lease whose heartbeat expired, with its recorded PID alive or absent | A lease is reclaimed only when the heartbeat is well past due and the process is gone; a live PID is never reclaimed on heartbeat delay alone, and reclaiming never signals or kills another process | Coordinator regression tests | Verified by regression only; not yet exercised on the primary Mac | Coordinator lease lifecycle changes |
| DEX-INV-026 | Coordination metadata carries no prompts, transcripts or credentials | Acquire, queue, heartbeat, release, and share-mode status | Persisted coordination files contain only the declared lease/ticket fields; label inputs are length- and charset-bounded, credential-shaped labels are refused, and share output omits repository paths, branches and PIDs | Coordinator regression tests + file content inspection | Verified by regression only; not yet exercised on the primary Mac | Coordinator schema, CLI, or share-report changes |
| DEX-INV-027 | Causal evidence links stages without exporting content | Any traced request, its refusals, and any inbound `traceparent`/`tracestate` | A span carries only identifiers, stage, outcome and hashes; arguments, file content, stdout/stderr, plan arguments, refusal messages and credentials are never recorded; `baggage` is never accepted; malformed inbound trace context starts a fresh trace instead of being repaired or trusted; trace storage is bounded and OpenTelemetry export stays off unless the owner enables it | Tracing regression tests + span field inspection | Verified by regression only; no deployed gateway/node pair has produced a live trace | Tracing, span schema, or trace-export changes |
| DEX-INV-028 | workspace-safe narrows execution and is narrowed by owner authority | A node configured with the `workspace-safe` execution profile, under every owner mode, client ceiling and grant | Owner modes stay exactly OFF/READ-ONLY/ON and no fourth mode appears; the profile admits inspection, reads, typed writes, checkpoints and the declared-safe compatibility tools, and refuses arbitrary shell, process/session tools, privileged, destructive and undeclared adapter surfaces; the refusal is evaluated against the node's own configured profile, so READ-ONLY cannot re-admit what the profile refuses; OFF, READ-ONLY, client ceilings and grants each still override or narrow it; a planned commit inherits its target's admission instead of laundering it | Workspace-safe regression tests | Verified by regression only; no node has run with the profile configured | Profile, execution-profile enforcement, or catalog workspace-safe changes |
| DEX-INV-029 | Rolling execution budgets only narrow authority | Owner-configured shared and per-client rolling budgets, including missing/corrupt budget files and concurrent reservations | A budget never transforms DENY into ALLOW; OFF, READ-ONLY, workspace-safe, client ceilings and grants still win; shared and per-client ceilings intersect by minimum; usage counters do not change the owner policy hash; a preauthorization denial consumes nothing; a successful reservation keeps its rolling cost after execution failure while releasing only the inflight concurrency slot; missing/corrupt budget policy is unrestricted because owner policy remains the authority source; corrupt usage with a real policy fails closed; plan/commit inherit the target's cost | Budget regression tests | Verified by regression only; no deployed node has enforced a live budget | Budget policy/usage, reservation, or CLI changes |

## Mandatory validation subsets

### Any MCP SDK or protocol-era change

- DEX-INV-001, 002, 005, 009, 017, 021
- `npm run typecheck`
- `npm test`, including the served-surface contract tests in `tests/mcp-contract.test.ts`
- `npm run build`
- deployed `npm run smoke` on the primary Mac before the build is installed
- a real ChatGPT or Claude client session, which synthetic SDK smoke does not substitute for

### Any gateway/MCP/auth change

- DEX-INV-001, 002, 005, 009, 012, 013, 017, 020, 021
- `npm run typecheck`
- `npm test`
- `npm run build`
- deployed `npm run smoke`

### Any node/executor/security change

- DEX-INV-002 through 012, 017, 018, 020, 021
- `npm run typecheck`
- `npm test`
- `npm run build`
- deployed `npm run smoke`

### Any execution-profile change

- DEX-INV-002, 006, 007, 028
- `npm run typecheck`
- `npm test`, including `tests/workspace-safe.test.ts`
- `npm run invariants -- --check`
- confirm no installed node's `DEX_REACH_PROFILE` changed value

### Any causal tracing change

- DEX-INV-027
- `npm run typecheck`
- `npm test`, including `tests/trace.test.ts`
- `npm run invariants -- --check`
- inspect a recorded span file directly and confirm it holds no arguments, content, output or credentials
- confirm `DEX_REACH_OTEL_EXPORT` is unset in any shipped configuration

### Any execution-budget change

- DEX-INV-002, 003, 010, 012, 029
- `npm run typecheck`
- `npm test`, including `tests/budget.test.ts`
- `npm run invariants -- --check`
- confirm budget usage files are not tracked by Git and that policy-hash tests still pass without grant consumption

### Any shared-machine coordination change

- DEX-INV-022 through 026
- `npm run typecheck`
- `npm test`
- `npm run invariants -- --check`
- confirm no coordinator state under `~/.dex-reach/coordinator/` is tracked by Git

### Any macOS install/launcher change

- DEX-INV-002, 015, 016, 017, 018
- `npm run install:macos`
- verify `~/.dex-reach/install-macos.status.json` is complete
- verify node reconnect/version/tool count
- `npm run verify:golden`
- `npm run install:dock`
- verify signed bundle, exact Dock URL, live Terminal console, and unchanged owner authority

### Before commit/push

- `npm run verify:golden`
- repeated full regression run when concurrency code changed
- `git diff --check`
- inspect all changed files, dependency manifests, deletions/renames, and untracked files
- verify no state/credential/private-key files are tracked
- reconcile README, SECURITY, Operational State, and this invariant manifest with observed evidence

## Evidence rule

Source presence proves implementation, not behavior. A passing unit test proves only the tested contract. A successful installer command does not prove the restarted service. A successful push does not prove hosted CI. Prefer the narrowest final observable for each claim and leave hardware/platform paths explicitly unverified when they were not exercised.
