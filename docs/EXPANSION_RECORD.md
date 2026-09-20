# DEX//REACH Expansion — Complete Record

As of 2026-09-20.

Fourteen of the fifteen phases in the expansion brief are implemented, swept twice for defects, and proved against a real gateway and node agent running as separate processes. Phase 3 is deliberately absent. **The branch has been installed on the primary Mac since revision r47** and the coordinator, gateway and node run there as persistent launchd services. **One release blocker remains**: the Mac is running a `6e01e6c`-era build, so the CI-green candidate carrying the repaired trace response has not been installed or exercised there, and the owner's own record says not to merge pull request #2 before that acceptance. Everything below is checkable against the branch `claude/work-coordinator-cpcug3` in `westkitty/DEX-REACH`, draft pull request #2. Check out the branch tip rather than a fixed hash: documentation commits sit on top of the code they describe.

## How to check this record yourself

Everything here is a claim about one commit, and each claim has a command that either confirms it or does not.

| Step | Command |
| --- | --- |
| Get the exact code | `git fetch origin claude/work-coordinator-cpcug3 && git checkout claude/work-coordinator-cpcug3` |
| Install from the lockfile alone | `npm ci` |
| Types | `npm run typecheck` |
| Invariant manifest matches the code | `npm run invariants -- --check` |
| Full test suite | `npm test` |
| Build | `npm run build` |
| Production dependency advisories | `npm audit --omit=dev --audit-level=high` |
| Rebuild is a function of tracked source | `npm run verify:clean-build` |
| Live gateway and node proof | `npm run proof -- --require-live` |

The last one is the important one. It starts a real gateway and a real node agent as separate operating-system processes on a loopback port in a throwaway state directory, enrolls the node through the owner CLI, and drives the pair with a real MCP client through a full OAuth flow. It writes `release/proof-run.json`, which records every proof item, the one environment that can establish it, and what a pass still does not prove.

GitHub Actions runs three separate jobs on every push so a failure is attributable rather than a single red mark: `validate`, `reproducible-build` and `runtime-proof`. All three were green on `dc7b341`, and the runs on the current branch tip are the ones to check for anything newer.

## The commit ledger

Thirty-two commits sat between `main` at `80fcbe1` and `5b08354`: 92 files changed, 15,879 insertions, 347 deletions. The count is given against `5b08354` rather than against the branch tip because the tip moves every time this record is corrected, and a record cannot honestly quote a hash it is itself about to change. The commits after it are the trace-metadata round and documentation; the table below lists them. They are listed in the order they were made. Every commit message carries its own before-and-after and its own sweep findings, so `git show <commit>` is the primary record and this table is the index to it.

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
| `d8cdc5f` | This record: one owner-facing document covering the whole expansion. Documentation only |
| `7f617ab` | Owner's own fix: Electron and Chromium helper processes no longer consume an anonymous coding-work slot in machine admission |
| `e43da6d` | Reconcile this record with that fix. Documentation only |
| `3fb0eaf` | Owner's own work: coordinator reliability hardening. Lifecycle-managed work-run leases, a sustained interactive capacity profile, one workload tree counted as one capacity consumer, an owner-visible activity ledger, and one coordination namespace per OS account. Adds DEX-INV-040 and 041 |
| `dc7b341` | Merge of that work with this branch |
| `df08077` | Verify that work and reconcile this record. Documentation only |
| `7a0e9c1` | Owner's own work: a local coordinator daemon over an account-private Unix socket, work-bundle CPU/memory/IO/network budgets, and a privacy-safe scheduler snapshot on `reach_list_nodes` |
| `6e01e6c` | Review of that daemon: refuse a coordinator socket owned by another account, and bind it under a restrictive umask |
| `1d82c74` | Owner's own reconciliation: rebase the Mac's local work onto `6e01e6c`, install the result, and record the installed runtime state |
| `6dc6ed8` | Correct this record for the installed runtime: the branch was already running on the Mac while the record still said not to install it |
| `5b08354` | Owner's own work: a caller-visible trace id on routed MCP results, a real Android device proof item, and `DEX-INV-042` for the coordinator daemon transport boundary |
| `0131deb` | Repair the `live-mcp-surface` proof, which asserted a routed-call property on an action the gateway answers itself |
| `096a248` | Owner's own work: move the trace id off a second content block and onto the result's `_meta`, so it stops polluting the payload |
| `7d606ea` | Follow the trace id to `_meta` in the proof client, which had been left parsing content blocks |
| `27e7023` | Owner's own work: record a real Samsung SM-X910 answering identity reads through DEX, and a real Claude client call against the installed runtime |

## Phase by phase

Every phase either adds a narrowing or adds evidence. None of them widens what an AI can do. Nothing was rewritten: the public MCP surface is still exactly 16 first-class actions and the compatibility split is still 26 local tools, 22 remote, 4 withheld.

### Phase 0A and 0B: shared-machine coordination

Several AI sessions can use one machine at once, so machine capacity and repository ownership became authority boundaries of their own. This added leases, a FIFO queue nobody can jump, live capacity probes, and seven `work-*` CLI commands. Two rules matter most. Holding a lease grants nothing: owner mode, client ceilings, grants, roots, profile and plan rules decide a request exactly as they would with no lease. And a stale lease is reclaimed only when its heartbeat is well past due and its process is actually gone, never by signalling or killing another agent's process. Coordination files carry only the declared lease fields, never prompt text, transcripts, command output or credentials.

One later fix, `7f617ab`, made by the owner rather than in this program: Electron and Chromium helper processes no longer consume an anonymous coding-work slot. Such helpers inherit their host application's command line, so a desktop application's renderer read as an independent coding session and took a slot from real work. The exclusion is constrained to the documented helper types (`renderer`, `gpu-process`, `utility`, `zygote`), and CPU load, memory pressure and thermal state are still evaluated independently of the slot count, so genuine contention from such a process still queues work.

A second body of owner work, `3fb0eaf`, hardened the coordinator further: work-run leases now have a managed lifecycle, a sustained interactive capacity profile was added, one workload process tree counts as one capacity consumer rather than several, and `dex activity` gives the owner a local view of which processes DEX actually owns. Two rules were added with it. The activity ledger keeps only a sanitised process label, never a raw command line, so no argument or credential can reach it, and a corrupt ledger fails visibly instead of emptying itself. And machine coordination and activity anchor to the OS account home rather than to a virtualised `HOME`, so a compatibility adapter that replaces `HOME` cannot split one physical machine into two schedulers. Those are `DEX-INV-040` and `DEX-INV-041`.

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

## The 42 release-blocking invariants

The expansion took the count from 21 to 41; post-install coordinator transport hardening added `DEX-INV-042`. Everything from `DEX-INV-022` onward is new in this expansion/hardening line. The invariants live in `docs/INVARIANTS.md` with their full preconditions and acceptable proof, and in `src/shared/invariants.ts` as a machine-readable index; a regression test fails if those two ever disagree.

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
| 040 | Owner-visible activity identifies DEX-owned processes without persisting command content | Regression plus the installed primary-Mac runtime |
| 041 | Machine coordination and activity have one namespace per OS account | Regression plus an installed cross-path smoke on the primary Mac |
| 042 | Coordinator daemon transport is owner-private and fail-closed | Regression plus installed daemon lifecycle/cross-path evidence; foreign-account ownership remains regression-proven |

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

**Phase 3, dual-era MCP, is absent.** The brief's own rollback rule says to keep legacy serving until modern serving is proven on the owner's machine. Installing the runtime does not by itself unlock it, and neither does a green CI run: the gate is the installed machine serving a real client through the repaired response contract, which is what `PND-010` still tracks. The code Phase 3 needs is already written and shipped unused.

**The project license is unchanged at `UNLICENSED`.** Choosing a license is an owner decision and nothing in the brief authorized one.

**Nothing is signed, attested or published as a release.** Provenance proves a build is a function of tracked source; it does not sign anything, and the manifest says so.

**Telemetry stays off by default.** OpenTelemetry export runs only when the owner turns it on.

**The npm audit gate was repaired, not weakened.** CI was failing on npm 10's retired quick-audit endpoint, which reports every failure as a misleading lockfile error. The fix pins npm 11, which uses the supported advisory endpoint. The gate itself is unchanged: `npm audit --omit=dev --audit-level=high`, still failing the job on any high or critical advisory in the production tree. Nothing was set to continue-on-error, no threshold was lowered and no exit status was suppressed.

**No unrelated refactoring.** Every change belongs to a phase.

**The branch is installed on the primary Mac as of r47, and pull request #2 remains a draft pending final trace/CI closure.** It was installed before a full `npm run verify:golden` completed: the reconciled head passed 42 focused coordinator, capacity, work-run and MCP-contract tests on the Mac along with typecheck, the invariant manifest, build, audit and the backend probe, and the full-suite run was queued under machine pressure rather than finished. That is the owner's call on the owner's machine, and it is recorded here so nobody later reads the install as evidence the whole gate passed. The build installed there is now several commits behind the branch, which is the subject of the release blocker in the lead.

## Where it stands, and what only the owner can do

### Validation at `6e01e6c`, the last commit that changes code

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run invariants -- --check` | Pass, 42 release-blocking invariants |
| `npm test` | 249 tests; 248 pass in the container, 249 pass on CI |
| `npm run build` | Pass |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `npm run probe:backend` | 26 compatibility tools |
| `npm run verify:clean-build` | Artifacts rebuild byte for byte from `git archive` |
| `npm run proof -- --require-live` | 19 proven, 0 failed, 3 unverified |

The single in-container test failure is a pre-existing and unrelated case in `tests/native.test.ts`. That container's shell profile prints `nvm` on startup, which contaminates the standard output that `dex.process.run` captures. It fails identically at the base commit `80fcbe1` and passes on CI, where the full suite is green. It was not weakened to make it pass.

That table is what this container ran. The owner ran a second, independent gate on the primary Mac before installing, recorded as r47 in `OPERATIONAL_STATE.md`: 42 of 42 focused coordinator, machine-capacity, work-run and MCP-contract tests, including the foreign-socket ownership regression added in `6e01e6c`, plus typecheck, the 41-invariant manifest as it stood before `DEX-INV-042` was added, a production build, a production dependency audit with 0 vulnerabilities, the 26-tool backend probe and `git diff --check`. That is a focused gate, not the full suite, and it is not `npm run verify:golden`. GitHub's DEX validation workflow and CodeQL are green on `6e01e6c`.

### The honest limits of everything above

Everything I verified was verified in a Linux cloud container. That container establishes nothing about the primary Mac's resource state, macOS pressure, launchd runtime behaviour, Keychain, live installed DEX behaviour or live asymmetric Mac-node authentication. A loopback pair on Linux proves the software path. It does not prove the installation.

The Mac is a separate source of evidence, and it should be read as separate. Everything below that happened on the Mac is the owner's own observation, recorded here as that and not re-verified from this container: the install and the services coming back, a real Claude Code client completing a `reach_fingerprint` call against the installed runtime with only that one tool pre-authorized, and a Samsung SM-X910 answering harmless identity reads through DEX over wireless ADB.

The gap that remains is narrower than it was and easy to misread. The Mac is running a build from the `6e01e6c` era. The CI-green candidate with the repaired trace response is not installed there. So the six-stage `mcp → gateway → node → authorize → execute → receipt` chain and the caller-visible trace id are proven over a loopback pair and in CI, and the last real-client trace taken on the Mac resolved with only `node → authorize → execute`, because that is what the older installed build produces. `CI-green` and `proven on the installed machine` are still different states, and the four proof-stale marks on `DEX-INV-005`, `009`, `017` and `021` still stand, unchanged at four.

### What only the owner can do

1. **Install the CI-green candidate on the primary Mac, then make one real routed call.** This is the release blocker and everything else waits behind it. The Mac is still running a `6e01e6c`-era build, so the repaired trace response has never been exercised there. The acceptance is three things at once: the useful payload still comes back, the caller-visible trace id is present in the MCP result metadata, and `npm run dex -- trace <id>` resolves the complete six-stage chain. This is `PND-010`, and the owner records that both authorized mutation channels for the reinstall were unavailable during the last attempt.
2. **Finish the gate that the earlier install ran ahead of.** `npm run verify:golden` has not completed at an installed head. The Mac passed a focused 42-test gate plus typecheck, invariants, build, audit and probe, and the full-suite run queued under machine pressure rather than finishing.
3. **Refresh the ChatGPT connector's action list.** That client still exposes 12 of the 16 DEX actions, so plan, commit, receipts and the trust report are not reachable from its user interface. The server contract is not the problem. This is `PND-001`.
4. **Authorize the install proof** by running the proof harness on a macOS host with `DEX_REACH_PROOF_ALLOW_INSTALL=1`. This is a separate thing from having installed the branch by hand: `fresh-node-install` only moves off unverified when the harness itself is allowed to perform an install.
5. **Run a real two-agent lease contention** on the Mac, which is what would take `DEX-INV-022` through `026` past regression and installed smoke.
6. **Configure a real rolling budget** on the installed node and confirm a live request is refused when exhausted without changing the owner policy hash. The installed node still has no budget configured.
7. **Decide the one remaining owner-only question:** the project license. The other two are already decided and recorded: the gateway moves to a dedicated authorization server, which is `PND-009`, and `dex.capability.request` does not become a public MCP action in this release, so the 16-action contract stays frozen.
8. **Decide what happens to pull request #2,** which is still a draft and which the owner's own record says should not be merged before the acceptance in item 1.

Four pending items remain open in `OPERATIONAL_STATE.md`: `PND-001`, `005`, `009` and `010`. `PND-005` is the one not listed above, and it is not owner-gated: it is a deliberate hold on replacing more compatibility primitives, so that widening the frozen 16-action contract does not get mixed into the migration proof.

The rest closed, and it is worth being precise about how, because several closed on the owner's own hardware rather than on anything provable from here. `PND-002` closed on a real Samsung SM-X910 answering identity reads through DEX. `PND-008` closed when a real Claude Code client completed a `reach_fingerprint` call against the installed runtime. `PND-016` closed when `DEX-INV-042` was minted for the coordinator daemon transport boundary. `PND-003`, `PND-004` and `PND-007` were not proven; they were reclassified out of pending work and remain recorded as unverified in the `UNV-` entries, which is where a reader should look for the second-machine and Linux gaps. `PND-006`, `011`, `012`, `013` and `015` closed earlier in the expansion.
