# DEX//REACH Expansion — Complete Record

As of 2026-09-19.

Fourteen of the fifteen phases in the expansion brief are implemented, swept twice for defects, and proved against a real gateway and node agent running as separate processes. Phase 3 is deliberately absent and this branch must not be installed on the primary Mac yet. Every claim below is checkable against commit `71079b3` on branch `claude/work-coordinator-cpcug3`, draft pull request #2.

## How to check this record yourself

Everything here is a claim about one commit, and each claim has a command that either confirms it or does not.

| Step | Command |
| --- | --- |
| Get the exact code | `git fetch origin claude/work-coordinator-cpcug3 && git checkout 71079b3` |
| Install from the lockfile alone | `npm ci` |
| Types | `npm run typecheck` |
| Invariant manifest matches the code | `npm run invariants -- --check` |
| Full test suite | `npm test` |
| Build | `npm run build` |
| Production dependency advisories | `npm audit --omit=dev --audit-level=high` |
| Rebuild is a function of tracked source | `npm run verify:clean-build` |
| Live gateway and node proof | `npm run proof -- --require-live` |

The last one is the important one. It starts a real gateway and a real node agent as separate operating-system processes on a loopback port in a throwaway state directory, enrolls the node through the owner CLI, and drives the pair with a real MCP client through a full OAuth flow. It writes `release/proof-run.json`, which records every proof item, the one environment that can establish it, and what a pass still does not prove.

GitHub Actions runs three separate jobs on every push so a failure is attributable rather than a single red mark: `validate`, `reproducible-build` and `runtime-proof`. All three are green on `71079b3`.

## The commit ledger

Twenty-one commits sit between `main` at `80fcbe1` and the branch head at `71079b3`: 71 files changed, 13,580 insertions, 307 deletions. They are listed in the order they were made. Every commit message carries its own before-and-after and its own sweep findings, so `git show <commit>` is the primary record and this table is the index to it.

| Commit | What it did |
| --- | --- |
| `7a837f1` | Shared-machine work coordinator: leases, a FIFO queue nobody can jump, capacity read as a ceiling rather than a target |
| `07ac664` | One operation and risk catalog, replacing the same knowledge restated in five separate places |
| `b0b4721` | MCP SDK v1 to v2 package split and zod 3 to 4, with the served semantics unchanged |
| `32af79b` | End-to-end causal tracing on W3C Trace Context, structurally unable to carry content |
| `c7950e2` | The `workspace-safe` execution profile: typed project work with no arbitrary shell |
| `b128735` | Rolling execution budgets that can only ever narrow authority |
| `a4b0f7e` | Capability requests: the AI may ask, only the owner grants |
| `77d46b0` | Custom policy assertions and append-only policy history |
| `6b96b84` | `dex doctor`, read-only, evidence-scoped and redactable |
| `fee7892` | Fail closed when a capability request cannot be risk-classified |
| `22286d6` | Asymmetric Ed25519 node transport auth, a key domain separate from receipt signing |
| `c4bc3e0` | First adversarial sweep of phases 6 to 10: five defects corrected |
| `7729f9f` | Second independent sweep of the same phases: two more defects, both in code the first sweep had already read |
| `615f205` | Run the CI audit gate on npm's supported advisory endpoint instead of the retired one |
| `bb95a4d` | Capability adapter contract: the adapter declares, DEX decides |
| `bc0139f` | Node-local secret broker, EXPERIMENTAL: the model names aliases and never sees values |
| `4067898` | Portable evidence bundles that verify offline and never claim more than they prove |
| `4a79ef4` | Release provenance: a build must be a function of tracked source at one commit |
| `ca1332b` | Make a failed provenance check say what actually failed |
| `393352c` | Physical and runtime proof, and the fix for the two defects that proof exposed |
| `71079b3` | Prove the served MCP contract against a running gateway, and record what that still does not close |

## Phase by phase

Every phase either adds a narrowing or adds evidence. None of them widens what an AI can do. Nothing was rewritten: the public MCP surface is still exactly 16 first-class actions and the compatibility split is still 26 local tools, 22 remote, 4 withheld.

### Phase 0A and 0B: shared-machine coordination

Several AI sessions can use one machine at once, so machine capacity and repository ownership became authority boundaries of their own. This added leases, a FIFO queue nobody can jump, live capacity probes, and seven `work-*` CLI commands. Two rules matter most. Holding a lease grants nothing: owner mode, client ceilings, grants, roots, profile and plan rules decide a request exactly as they would with no lease. And a stale lease is reclaimed only when its heartbeat is well past due and its process is actually gone, never by signalling or killing another agent's process. Coordination files carry only the declared lease fields, never prompt text, transcripts, command output or credentials.

### Phase 1: one operation catalog

Operation identity, risk class, mutation status and required capability had been restated in five places that could drift apart. They now live once, in `src/shared/operations.ts`.

### Phase 2: MCP SDK v2

The migration from SDK v1 to the v2 package split, and zod 3 to zod 4, with the served semantics deliberately unchanged. The dual-era pieces Phase 3 needs are already written and shipped, unused: `classifyInboundRequest`, `legacyStatelessFallback` and `ProtocolEra`.

### Phase 3: dual-era MCP

Deliberately absent. See "What was deliberately not done".

### Phase 4: causal tracing

One request can now be reconstructed end to end across gateway, node and executor, on W3C Trace Context. A span is structurally unable to carry content: it holds identifiers, stage, outcome and hashes, and never arguments, file content, standard output, plan arguments, refusal text or credentials. Inbound `baggage` is never accepted, malformed inbound trace context starts a fresh trace rather than being repaired or trusted, storage is bounded, and OpenTelemetry export stays off unless the owner turns it on.

### Phase 5: the workspace-safe execution profile

Before this a node was either read-only or had arbitrary shell, with nothing in between. `workspace-safe` admits inspection, reads, typed writes, checkpoints and the declared-safe compatibility tools, and refuses arbitrary shell, process and session tools, and anything privileged, destructive or undeclared. It is a separate axis from the owner's mode: the owner still has exactly OFF, READ-ONLY and ON, no fourth mode appeared, and READ-ONLY cannot re-admit what the profile refuses.

### Phase 6: rolling execution budgets

Shared and per-client rolling budgets that only ever narrow. A budget can never turn a refusal into an approval, shared and per-client ceilings intersect by taking the minimum, a denied preauthorization consumes nothing, and a reservation that executes and then fails keeps its rolling cost while releasing only its concurrency slot. Missing budget policy is unrestricted because owner policy remains the authority source; corrupt usage against a real policy fails closed. Twenty simultaneous reservations against a ceiling of five admit exactly five.

### Phase 7: capability requests

An AI can ask for a capability instead of the owner hand-editing policy. Creating a request creates no grant and does not change the owner policy hash. Only local owner approval creates an ordinary grant, approval may narrow and cannot widen, and the decision is recorded before the grant exists, so a failed approval can never leave a live grant the log does not explain.

### Phase 8: policy assertions and history

The owner can attach custom assertions that a candidate policy must satisfy before it is written; a violating write is refused rather than persisted. Policy history is append-only, and restoring an old revision creates a new revision rather than erasing what happened.

### Phase 9: dex doctor

A read-only diagnostic with plain, JSON, deep and share modes. Share output is redacted, and the whole command is evidence-scoped: it reports what it checked, not a verdict on the system.

### Phase 10: asymmetric node transport authentication

Nodes authenticate with Ed25519 proofs instead of a bearer token. The gateway stores only public keys, private keys never persist in `node-auth.json`, enrollment tokens are one-use, and a node that has migrated to asymmetric cannot silently downgrade to bearer. This is a different cryptographic domain from receipt signing, and the two key sets are never shared. A proof cannot be replayed inside its validity window, and nonce capacity is counted per node so one node exhausting its own share cannot refuse another node's proofs.

### Phase 11: the capability adapter contract

An adapter's manifest must declare, for every tool, the required DEX capability, risk class, mutation, network reach, path-bearing arguments, workspace-safe eligibility, plan eligibility, remote blocking, reversibility and checkpoint strategy. An absent or incomplete declaration is refused rather than defaulted, and a declaration that disagrees with the DEX catalog is refused rather than accepted, so a manifest can only fail to admit a tool and can never widen one. Remote clients can inspect and call admitted tools but have no install, update, manifest-edit or adapter-policy path.

### Phase 12: the node-local secret broker (EXPERIMENTAL)

The model names aliases and never receives a value. A value is read from the node's own mode-0600 store after final authorization and immediately before the local invocation, never at the gateway, never in MCP, never at request creation and never during planning. It is injected into exactly one child process's environment and never onto a command line. `secret.use` is an independent capability: holding shell, file and every other capability combined does not grant it, and holding it alone grants no shell. READ-ONLY and workspace-safe refuse injection outright. No value appears in any plan, audit entry, receipt, trace, checkpoint, share report, evidence bundle or Git object.

### Phase 13: portable evidence bundles

A bundle carries identifiers, hashes, signed receipts, sanitized trace spans and its own limitations, and no file content, output, credentials, private keys, secret values or raw request arguments. Verification runs offline from the bundle alone and answers each claim separately; it never emits one overall VERIFIED. Four things are always reported as unproven because no bundle can establish them about itself: node identity, bundle completeness, trace completeness and external side effect.

### Phase 14: release provenance

Build artifacts must rebuild byte for byte from `git archive` of the commit, installed from the lockfile alone, in a different absolute path, with no pre-existing build output. A difference names the file and its likely cause. A build that fails in a clean checkout is reported as a reproducibility failure and an install failure as unverified, never as each other, and a dirty working tree makes the comparison unverified rather than producing a wall of false differences.

### Phase 15: physical and runtime proof

See "What the proof run establishes, and where".

## Every defect found and fixed

Nine defects were found after the code that contained them was written, and every one was reproduced as an observed failure before being fixed.

### The first adversarial sweep, `c4bc3e0`

A pass over phases 6 to 10, each defect reproduced against `22286d6` in a throwaway checkout first.

| Defect | What was observed |
| --- | --- |
| Budget laundering through the compatibility adapter | The same 4,096-byte write cost 4,096 natively and 0 through the adapter; a 30-second timeout cost 30,000 natively and 0 through the adapter |
| Per-client budgets measured every client | With a ceiling of 2 operations for one client, its first request was refused after four unrelated requests from a different client |
| Abandoned concurrency slots were never released | A slot abandoned 24 hours earlier still occupied the ceiling, and the array grew without bound across crashes |
| A corrupt capability request log was silently emptied and overwritten | After corrupting the file the existing request became invisible, and its id was gone from disk once a new request was filed, destroying the record explaining why a live grant exists |
| Nonce eviction opened a replay window | A captured transport proof, correctly refused as a replay while remembered, authenticated successfully once the cache filled past 4,096 entries |

### The second adversarial sweep, `7729f9f`

This pass was run over the same scope without trusting the first pass's own report. Both defects it found were in code the first pass had examined and written notes about, and one of them was introduced by the first pass's own fix.

| Defect | What was observed |
| --- | --- |
| One node could deny every other node authentication | Failing closed at nonce capacity was correct, but the ceiling counted every node's nonces together. One enrolled node issuing 4,095 ordinary proofs, about 13.7 per second, made a second idle node's next proof fail. Capacity is now counted per node |
| A failed capability-request approval left a live grant the request log did not explain | The grant was written before the decision was recorded, so a failure in between left authority in owner policy while the request still read expired with no grant id. The decision is now recorded first |

The lesson carried forward: a previous pass's note that something was reviewed and deliberately left alone is a weaker claim than it reads as, and a pass's own fix is itself unreviewed code.

### What the live proof run found, `393352c`

Neither of these could have been caught by any test in this repository, because every test here constructs its module's inputs directly and so never crosses the seam between gateway, node and client.

**The gateway advertised an OAuth behaviour it did not perform.** Its discovery document carries `authorization_response_iss_parameter_supported`, which the MCP SDK's auth router emits by default. But DEX//REACH emits its authorization response from its own `/dex/approve` route rather than from inside `/authorize`, so the SDK's redirect wrapper never saw it and the RFC 9207 `iss` parameter was never appended. A spec-compliant client must refuse a response without it. Every such MCP client stopped dead at the callback, against a gateway that answered its health check, listed its tools and looked entirely healthy. `npm run smoke` had the same blind spot from the other side: it handed `finishAuth` a bare code, discarding the parameter the check needs. The fix is covered by a regression test whose counterfactual was confirmed by removing the fix and watching the test go red.

**A re-enrolled node could never get back in.** After an owner revokes a node, forgets it and enrolls it again, the node host still holds the transport private key from before while the gateway has forgotten the matching public key. The node presented that proof, was refused at the websocket upgrade with no reason given — deliberately, so that a prober learns nothing — and then retried the same refused proof forever with nothing in either log saying why. The node now alternates credentials when it is refused before the connection opens, and says which one it is trying.

### Two smaller fixes

`fee7892` made a capability request that cannot be risk-classified refuse rather than quietly default to the lowest risk class. `ca1332b` made a failed provenance check say what actually failed instead of reporting a generic drift.

## The 39 release-blocking invariants

The expansion took the count from 21 to 39: everything from `DEX-INV-022` onward is new here. They live in `docs/INVARIANTS.md` with their full preconditions and acceptable proof, and in `src/shared/invariants.ts` as a machine-readable index; a regression test fails if those two ever disagree.

"Regression only" means a test proves the contract and no deployed system has exercised it. "Proof stale" means it was verified on the deployed 0.3.2 worker and has not been re-verified since the MCP SDK v2 migration.

| ID | Protected capability | Proof state |
| --- | --- | --- |
| 001 | Explicit machine selection, no node fallback | Verified |
| 002 | Node-local owner authority | Verified |
| 003 | Fail-closed policy | Verified |
| 004 | Filesystem scope, including symlinks | Verified |
| 005 | Compatibility configuration stays node-owned | Proof stale since SDK v2; loopback client saw the correct 22-tool surface |
| 006 | READ-ONLY is shell-free | Verified |
| 007 | ON and full-local limits are stated honestly | Verified |
| 008 | Process children do not inherit credentials | Verified on deployed 0.3.2 |
| 009 | Remote transport protects credentials | Proof stale; the loopback pair exercises only the branch that needs no HTTPS or WSS |
| 010 | An exact plan executes at most once | Verified |
| 011 | Receipts are signed and linear | Verified after repairing a reproduced stale-lock race |
| 012 | Concurrent owner and state writes do not lose authority | Verified |
| 013 | Credentials are independent and revocable | Verified |
| 014 | Public source grants no runtime authority | Verified for the inspected tree |
| 015 | Persistent self-update survives transport replacement | Verified |
| 016 | The Dock launcher is not an authority escalator | Verified; final post-build reproof pending |
| 017 | The public MCP surface is exactly 16 first-class tools | Proof stale since SDK v2; a real client listed exactly 16 against a loopback gateway |
| 018 | ADB availability is not faked | Verified on the primary Mac |
| 019 | Simulation stays labelled simulation | Verified |
| 020 | Planned mutations bind execution identity | Verified on deployed 0.3.2 |
| 021 | Live trust reports stay evidence-scoped | Proof stale since SDK v2; a live report was fetched through a real client on the loopback pair |
| 022 | Machine workload admission grants no execution authority | Regression only |
| 023 | Repository mutation ownership is exclusive | Regression only |
| 024 | Exhausted capacity queues rather than oversubscribes | Regression only |
| 025 | Stale coordination state is reclaimed without terminating processes | Regression only |
| 026 | Coordination metadata carries no prompts, transcripts or credentials | Regression only |
| 027 | Causal evidence links stages without exporting content | Regression only |
| 028 | workspace-safe narrows, and is itself narrowed by owner authority | Regression only |
| 029 | Rolling execution budgets only narrow authority | Regression only |
| 030 | Capability requests never grant authority | Regression only |
| 031 | Policy assertions and append-only policy history | Regression only |
| 032 | Node transport auth is a separate cryptographic domain from receipt signing | Regression plus one complete live enrollment ceremony |
| 033 | A transport proof cannot be replayed inside its validity window | Regression only |
| 034 | A capability adapter declares; DEX decides | Regression only |
| 035 | Node-local secret values never leave the node | EXPERIMENTAL; regression only |
| 036 | Evidence bundles are portable, content-free and never overclaim | Regression only |
| 037 | A release is a function of tracked source at one commit | Regression plus one executed clean-build comparison |
| 038 | A proof run records only what it observed, and absent hardware is never a pass | Regression plus executed proof runs |
| 039 | The gateway never advertises an authorization behaviour it does not perform | Regression plus one live MCP client completing OAuth |

## What the proof run establishes, and where

`npm run proof` reports 19 proven, 0 failed and 3 unverified. Unverified is a third outcome, not a soft failure: the run exits non-zero only on a proof that actually ran and did not hold.

| Proof | Environment | Result |
| --- | --- | --- |
| A node installs from nothing onto a real host | macOS host | Unverified, hardware not available |
| A newly enrolled node starts with AI access OFF | this process | Proven |
| Every request names one node, and an unknown node is refused | live pair | Proven |
| A node authenticates to a live gateway with an Ed25519 proof | live pair | Proven |
| The node reports an execution fingerprint of the real host | this process | Proven |
| READ-ONLY admits inspection | this process | Proven |
| READ-ONLY refuses mutation through the whole path | live pair | Proven |
| The workspace-safe profile refuses what it is supposed to refuse | this process | Proven |
| A typed mutation executes inside its declared roots | this process | Proven |
| Arbitrary shell is refused where it is not authorized | this process | Proven |
| A capability grant expires and exhausts | this process | Proven |
| A rolling budget exhausts and refuses | this process | Proven |
| Machine admission holds across real processes | this process | Proven |
| The owner kill switch stops work already in flight | live pair | Proven |
| A revoked node is disconnected and stays out | live pair | Proven |
| A revoked node can be deliberately re-enrolled | live pair | Proven |
| Execution produces a linked trace | this process | Proven |
| Receipts are signed and chained, and tampering breaks them | this process | Proven |
| An evidence bundle verifies offline | this process | Proven |
| A real MCP client sees exactly the contracted surface on a running gateway | live pair | Proven |
| ADB operations run against a real Android device | Android device | Unverified, hardware not available |
| Two physically separate machines stay distinct | second machine | Unverified, hardware not available |

### Why the run cannot flatter itself

`reconcileProofRun` in `src/shared/proof-matrix.ts` is the only place a result may come into existence, and it does not trust its caller.

- A pass reported for hardware that was not present is discarded, and the report says it was discarded rather than silently dropping it.
- A failure reported for absent hardware becomes unverified, because missing hardware is not evidence that something is broken.
- An item nobody attempted says it was not attempted, rather than being omitted and reading as fine.
- An observation naming an unknown item, or naming one twice, is an error rather than a line that vanishes.
- The verdict is computed over the required list rather than over the results, so a narrowed catalog cannot report full coverage of fewer things.
- The report carries no hostname.

The cross-process proofs hold every contender until all of them have reported, rather than sleeping for a guessed interval. Twenty separate operating-system processes against a five-slot ceiling admit exactly five, and that count cannot come out right for the wrong reason because an early contender released its slot.

## What was deliberately not done

**Phase 3, dual-era MCP, is absent.** The brief's own rollback rule says to keep legacy serving until modern serving is proven on the owner's machine. The loopback proof does not unlock it, because the gate is about the deployed gateway rather than about any running gateway. The code Phase 3 needs is already written and shipped unused.

**The project license is unchanged at `UNLICENSED`.** Choosing a license is an owner decision and nothing in the brief authorized one.

**Nothing is signed, attested or published as a release.** Provenance proves a build is a function of tracked source; it does not sign anything, and the manifest says so.

**Telemetry stays off by default.** OpenTelemetry export runs only when the owner turns it on.

**The npm audit gate was repaired, not weakened.** CI was failing on npm 10's retired quick-audit endpoint, which reports every failure as a misleading lockfile error. The fix pins npm 11, which uses the supported advisory endpoint. The gate itself is unchanged: `npm audit --omit=dev --audit-level=high`, still failing the job on any high or critical advisory in the production tree. Nothing was set to continue-on-error, no threshold was lowered and no exit status was suppressed.

**No unrelated refactoring.** Every change belongs to a phase.

**The branch is still DO NOT INSTALL, and pull request #2 is still a draft.**

## Where it stands, and what only the owner can do

### Validation at `71079b3`

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run invariants -- --check` | Pass, 39 release-blocking invariants |
| `npm test` | 232 tests; 231 pass in the container, 232 pass on CI |
| `npm run build` | Pass |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `npm run probe:backend` | 26 compatibility tools |
| `npm run verify:clean-build` | Artifacts rebuild byte for byte from `git archive` |
| `npm run proof -- --require-live` | 19 proven, 0 failed, 3 unverified |

The single in-container test failure is a pre-existing and unrelated case in `tests/native.test.ts`. That container's shell profile prints `nvm` on startup, which contaminates the standard output that `dex.process.run` captures. It fails identically at the base commit `80fcbe1` and passes on CI, where the full suite is green. It was not weakened to make it pass.

### The honest limits of everything above

All of this work was done in a Linux cloud container. It establishes nothing about the primary Mac's resource state, macOS pressure, launchd runtime behaviour, Keychain, live installed DEX behaviour or live asymmetric Mac-node authentication. A loopback pair on Linux proves the software path. It does not prove the installation.

### What only the owner can do

1. **Do not install this branch on the primary Mac yet.** Nothing here has been installed or deployed anywhere.
2. **Run `npm run verify:golden` and a real ChatGPT or Claude client session against the migrated build on the Mac, before installing it.** This is what clears the proof-stale marks on `DEX-INV-005`, `009`, `017` and `021`, and it is the gate that unlocks Phase 3.
3. **Authorize the install proof** by running the proof on a macOS host with `DEX_REACH_PROOF_ALLOW_INSTALL=1`, the only way `fresh-node-install` can move off unverified.
4. **Attach an Android device** and perform one harmless hardware identity operation through DEX.
5. **Enroll a real second machine** and repeat explicit-node routing plus the OFF, READ-ONLY and ON checks.
6. **Run a node with `DEX_REACH_PROFILE=workspace-safe`** and confirm from real refusals that a typed write and a checkpoint succeed while `dex.process.run` and the process and session compatibility tools are refused.
7. **Produce one real end-to-end trace** and confirm the returned trace id resolves through `npm run dex -- trace <id>` with the expected stage chain.
8. **Run a real two-agent lease contention** on the Mac, which is what would take `DEX-INV-022` through `026` past regression.
9. **Configure a real rolling budget** and confirm a live request is refused when exhausted without changing the owner policy hash.
10. **Decide three owner-only questions:** the project license; whether the gateway keeps its own OAuth authorization server or moves to a dedicated one, which upstream recommends for production; and whether `dex.capability.request` should become a public MCP action, which would expand the 16-action contract.
11. **Decide what happens to pull request #2.**

Items 1 through 9 are recorded in `OPERATIONAL_STATE.md` as numbered pending work.
