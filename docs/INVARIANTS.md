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
| DEX-INV-030 | Capability requests never grant authority | AI-created capability request, owner approve/deny/expiry, and owner narrowing | Creating a request does not create a grant or change the owner policy hash; only local owner approval creates an ordinary CapabilityGrant; owner approval may narrow and cannot widen; deny and expiry create no grant; the approval decision is recorded before the grant is created, so a failed approval leaves no live grant that the request log does not explain; OFF still refuses execution after approval; raw secret-bearing arguments are not stored; an explicit unknown operation is refused rather than recorded as inspect; capability-only requests carry the highest catalog-derived risk of the requested capabilities and never default to inspect | Capability-request regression tests | Verified by regression only; not advertised as a public MCP action | Capability-request store, approval, or grant creation changes |
| DEX-INV-031 | Policy assertions and append-only policy history | Owner policy mutation, custom assertions, grant-use counters, and restore | Candidate owner policy is checked with built-in policyCheck plus custom assertions before persist; a violating write is refused; history is append-only; restoring an old revision creates a new revision; grant-use counters do not append history | Policy-assertion regression tests | Verified by regression only | Policy assertion, history, or owner persist changes |
| DEX-INV-032 | Node transport authentication is a separate cryptographic domain from receipt signing | Enrollment token, transport Ed25519 proof, legacy bearer coexistence, revocation, and gateway persistence | Transport keys are not receipt keys; gateway state stores only public keys; private keys never persist in node-auth.json; unknown/revoked/wrong-key/tampered/stale/future/replay/wrong-node/wrong-path/incompatible-protocol proofs fail; enrollment tokens are one-use; a migrated asymmetric node cannot silently downgrade to bearer; legacy bearer remains valid during an explicit migrating state | Node-transport-auth regression tests plus an executed live enrollment ceremony | Verified by regression and by one live gateway/node pair that completed the whole ceremony -- one-use token, node-held key, migration, reconnection by signed proof, bearer then refused -- on a Linux loopback pair started by `npm run proof`. No such ceremony has been completed on the primary Mac or against the deployed gateway | Node transport auth, enrollment, or node websocket authentication changes |
| DEX-INV-033 | A node transport proof cannot be replayed within its validity window | Any accepted `/node` transport proof, including when the gateway's nonce cache is full | A nonce is remembered for the whole proof validity window and a second presentation is refused as `replay`; the cache drops only nonces whose window has closed, and when every slot holds a still-replayable nonce a new proof is refused as `nonce-capacity` rather than evicting a live entry; that capacity is counted per node, so one node exhausting its own share never refuses another node's proofs | Transport-auth and correction regression tests | Verified by regression only. A live gateway has now served an asymmetric node (see DEX-INV-032), but replay and nonce capacity were not exercised against it; the primary Mac and the deployed gateway remain unexercised | Node transport authentication, nonce cache, or proof timing changes |
| DEX-INV-034 | A capability adapter declares; DEX decides | Installing or updating any capability adapter, including the pinned Desktop Commander compatibility adapter | The adapter's manifest must declare, for every tool, the required DEX capability, risk class, mutation, network reach, path-bearing arguments, workspace-safe eligibility, plan eligibility, remote blocking, reversibility and checkpoint strategy; an absent or incomplete declaration is refused rather than defaulted, and a declaration that disagrees with DEX's own catalog on any of those facts is refused rather than accepted, so a manifest can only fail to admit a tool and never widen one; a tool DEX does not classify, one attributed to another adapter, and one the manifest omits are each refused; remote clients may inspect and call admitted tools but have no install, update, manifest-edit or adapter-policy path; routing a call through the adapter wrapper demands the tool's own capability in addition to `compat`; the remote surface stays exactly the approved 22 of 26 tools | Adapter contract regression tests | Verified by regression only; no deployed node has started under the adapter registry | Adapter contract, adapter manifest, compatibility tool catalog, or remote tool surface changes |
| DEX-INV-035 | Node-local secret values never leave the node | Any request naming a stored secret alias, on any operation, in any owner mode or execution profile | The model names aliases only and never receives a value; the value is read from the node's own 0600 store after final authorization and immediately before the local invocation, never at the gateway, in MCP, at request creation or during planning; it is injected into exactly one child process's environment and never onto a command line; `secret.use` is an independent capability, so holding shell, file and every other capability combined does not grant it and holding it alone grants no shell; an operation that cannot inject a named alias refuses the request rather than running without the credential; READ-ONLY and workspace-safe refuse injection outright, because READ-ONLY admission never consults a capability grant; an unknown alias, a corrupt store, a forbidden environment name and a value too short to scrub are each refused rather than defaulted; no value appears in any plan, audit entry, receipt, trace, checkpoint, share report, evidence bundle or Git object; and no first-class MCP action accepts an alias, so the only remote route to a credential-bearing call is an exact one-use plan | Secret broker regression tests, including a disk-wide search for the value across every artifact a run writes, and an import-graph assertion that only the node executor reaches the resolve path | EXPERIMENTAL. Verified by regression only; no deployed node has brokered a secret, and output scrubbing is best effort against a command that transforms or forwards a value rather than echoing it | Secret broker, capability derivation, node dispatch, execution profiles, or read-only admission changes |
| DEX-INV-036 | Evidence bundles are portable, content-free, and never claim more than they prove | Exporting or verifying any evidence bundle | A bundle carries identifiers, hashes, signed receipts, sanitized trace spans and its own limitations, and carries no file content, stdout/stderr, credentials, private keys, secret values, raw owner policy or raw request arguments unless the owner attaches an explicit disclosure; verification runs offline from the bundle alone, answers each claim separately, and never emits a single overall VERIFIED; node identity, bundle completeness, trace completeness and external side effect are always reported as unproven, because no bundle can establish them about itself; a relabelled node id, an edited receipt, a broken chain, a mismatched disclosure and a structurally invalid bundle each fail their own claim without taking down the others; an export that cannot honour what was asked refuses and names what is missing rather than silently narrowing | Evidence bundle regression tests, including a search of a real exported bundle for content that must not be in it and a fully re-signed forgery that passes every structural claim | Verified by regression only; no bundle has been exported from a deployed node, and offline verification has not been exercised by a third party on another machine | Evidence bundle format, receipt format, trace span schema, or verification claim changes |
| DEX-INV-037 | A release is a function of tracked source at one commit, and says what it does not prove | Producing release provenance, or any CI run | Build artifacts must rebuild byte for byte from `git archive` of the commit, installed from the lockfile alone, in a different absolute path, with no pre-existing build output; a difference names the file and its likely cause rather than reporting that something drifted; a build that fails in a clean checkout is reported as a reproducibility failure and an install failure is reported as unverified, never as each other; a dirty working tree makes the comparison unverified rather than a wall of false differences; the release manifest records the exact commit, toolchain, artifact checksums and a normalized SBOM hash, states every check it could not run with its reason instead of omitting it, holds macOS, Android and second-machine claims at UNVERIFIED — HARDWARE NOT AVAILABLE unless actually exercised, never claims a live deployment was exercised, and carries its own limitations | Provenance regression tests plus an executed clean-build comparison | Verified by regression and by one executed comparison; no signed or attested release artifact has been published, and the project licence is deliberately unchanged | Build configuration, workflow, release tooling, or dependency manifest changes |
| DEX-INV-038 | A proof run records only what it observed, and absent hardware is never a pass | Any run of `npm run proof`, or any report derived from one | Every proof item declares the one environment that can establish it and what a pass still does not prove; an item whose environment was not present in the run is recorded as `UNVERIFIED — HARDWARE NOT AVAILABLE` with the reason, and a `pass` reported for it is discarded and said to have been discarded rather than silently dropped; a `fail` reported for an absent environment is likewise recorded as unverified, because missing hardware is not evidence that a feature is broken; an item nobody attempted is unverified and says it was not attempted rather than reading as fine; an observation naming an unknown item, or naming one twice, is an error rather than a line that vanishes; the run is declared physically proven only when every one of the nineteen required items passed in that same run; and the report carries no hostname | Proof-matrix regression tests plus an executed proof run | Verified by regression and by executed runs. 18 of the 19 required items are established on a Linux container with a live gateway/node pair; `fresh-node-install` requires a macOS host the owner authorizes and stays unverified |  Proof matrix, proof runner, or environment detection changes |
| DEX-INV-039 | The gateway never advertises an authorization behaviour it does not perform | Any OAuth authorization response, and any change to the authorization routes or the MCP SDK | The authorization response the gateway emits from its own owner-approval route carries the RFC 9207 `iss` parameter, holding exactly the issuer identifier its discovery document publishes, because that document advertises `authorization_response_iss_parameter_supported` and a spec-compliant client refuses a response without it; more generally, any behaviour the discovery document claims must be performed by the route that actually answers, including routes the SDK's own auth router never sees | OAuth regression tests plus an executed authorization by a real MCP SDK client against a running gateway | Verified by regression and by one live MCP client completing OAuth and calling tools against a loopback gateway. The deployed public gateway has not been re-exercised since this was fixed | OAuth provider, approval route, discovery metadata, or MCP SDK version changes |

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

### Any node transport authentication change

- DEX-INV-009, 013, 032, 033
- `npm run typecheck`
- `npm test`, including `tests/node-transport-auth.test.ts` and `tests/phase-6-10-corrections.test.ts`
- `npm run invariants -- --check`
- confirm no private key material is written to gateway state, receipts, audit or docs

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

### Any node transport-authentication change

- DEX-INV-013, 032
- `npm run typecheck`
- `npm test`, including `tests/node-transport-auth.test.ts` and `tests/node-auth.test.ts`
- confirm gateway `node-auth.json` fixtures never contain private key PEM
- confirm transport key files are not receipt key files

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
