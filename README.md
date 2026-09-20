---

<div align="center">

# DEX//REACH

![Status](https://img.shields.io/badge/Status-ready%20for%20second--device%20install-success.svg)
![Protocol](https://img.shields.io/badge/Protocol-MCP-blue.svg)
![Runtime](https://img.shields.io/badge/Runtime-Node.js%2022+-green.svg)
![Language](https://img.shields.io/badge/Language-TypeScript-blue.svg)
![Access](https://img.shields.io/badge/Access-node--local%20policy-orange.svg)

</div>

<p align="center">
Secure, explicit remote computing for ChatGPT, Claude, and other MCP clients.
</p>
<p align="center">
AI can reach the machine. The machine still decides what happens.
</p>

---

<!--
AI / maintainer note:
README.md is the human-facing project overview.
OPERATIONAL_STATE.md is the authoritative current-state and verification record.
Read both before making substantive changes.
-->

## What This Is

DEX//REACH is a self-hosted remote-computing control plane for AI clients.

It gives ChatGPT, Claude Code, or another MCP client a single authenticated MCP surface, then routes each request to an explicitly selected machine running a DEX//REACH node. The node decides whether the request is allowed, which folders are in scope, which operations are permitted, and whether that AI client is allowed to act at all.

It is not an unauthenticated remote shell, and installing a node does **not** permanently hand a computer to ChatGPT.

The important design rule is simple:

> **The device owner is the final authority.**

A node can be locally set to `off`, `read-only`, or `on`; access can be temporary; individual AI clients can be capped or blocked; and a missing or corrupt policy fails closed.

---

## Current Project Status

| Area | State |
| --- | --- |
| ChatGPT Business custom MCP app | **Verified** — real node discovery, fingerprint, file write/read, and process execution |
| Claude Code MCP client | **Verified** — real DEX//REACH calls completed |
| Primary macOS node | **Verified** — persistent gateway/node services and live routing |
| Node-local AI kill switch | **Verified** against real ChatGPT and Claude |
| Capability grants + policy assertions | **Verified in 0.3.1** — unit/concurrency coverage plus deployed public-MCP smoke |
| Exact-action plan/commit + signed receipts | **Verified in 0.3.1** — deployed plan→commit execution and signed-receipt visibility |
| Two-node routing and policy isolation | **Verified** with a live isolated second-node simulation |
| Second physical device | **Ready for install, not yet hardware-verified** |
| Primary macOS service install/reload | **Verified in 0.3.1** — self-hosted install returns before a one-shot launchd reloader replaces gateway/node; node-only fresh-Mac proof remains pending |
| Linux systemd path | **Implemented, not yet tested on a real Linux host** |
| Windows process execution | **Not supported yet** |
| Android ADB hardware | **Verified on primary Mac** — wireless ADB connected a Samsung SM-X910; raw ADB state was `device`, DEX `reach_adb_devices` saw the same transport, and harmless identity reads through DEX returned samsung / SM-X910 / Android 16 / SDK 36 |
| Owner activity ledger | **Verified installed** — persistent runtime exposes owner-safe `activity` plus daemon-backed scheduler/queue state; share mode omits local paths/PIDs |
| Local coordinator daemon | **Verified installed** — `com.stinkyweasel.dex-reach.coordinator` runs persistently and serves queue/capacity state for native and compatibility execution paths |

For the detailed evidence, current limitations, and exact verification matrix, read [`OPERATIONAL_STATE.md`](OPERATIONAL_STATE.md).

---

## Why This Exists

Remote AI tools are useful, but "give the model a computer" is a terrible trust model.

DEX//REACH separates four things that should stay separate:

1. **The gateway** decides which authenticated AI clients may request work.
2. **The node identity** decides which physical machine the request targets.
3. **The node policy** decides whether that machine will accept the request.
4. **The execution profile and allowed roots** decide what the accepted request may actually touch.

That means one machine can be fully enabled while another is disabled, one client can be read-only while another is blocked, and a typo or offline node can never silently fall through to a different computer.

---

## Architecture

```text
ChatGPT / Claude Code / other MCP client
                  |
                  v
        OAuth + PKCE + MCP
                  |
                  v
        DEX//REACH Gateway
        - client approval
        - explicit node routing
        - token / session handling
        - audit + bounded results
                  |
          authenticated WSS
                  |
        +---------+---------+
        |                   |
        v                   v
  gateway node         another node
  local policy         local policy
  local roots          local roots
  local audit          local audit
        |                   |
        v                   v
 native operations / compatibility adapter
```

Nodes connect **outbound** to the gateway. They do not expose a raw inbound shell or listener to the internet.

Every remote operation names a `node_id`. Unknown, blank, offline, or revoked IDs fail. There is no default execution target and no fallback to another machine.

---

## What It Can Do

DEX//REACH currently exposes 16 first-class MCP actions:

| Action | Purpose |
| --- | --- |
| `reach_list_nodes` | List enrolled machines, online state, identity, profile, roots, and local AI-access state |
| `reach_list_tools` | List compatibility-adapter tools available on one selected node |
| `reach_call` | Invoke one compatibility tool on one explicit node |
| `reach_fingerprint` | Prove which physical/runtime environment will execute work |
| `reach_trust_report` | Return a fresh evidence-scoped trust certificate with runtime checks, fingerprint, access state, invariant IDs, and certificate hash |
| `reach_repo_info` | Inspect Git repository state without mutating it |
| `reach_adb_devices` | Discover Android devices visible to a node through ADB |
| `reach_checkpoint` | Capture a reversible Git worktree checkpoint |
| `reach_file_read` | Read a bounded UTF-8 file inside the node's allowed roots |
| `reach_file_write` | Write or append UTF-8 text inside allowed roots |
| `reach_process_run` | Run a bounded guarded shell command on the selected node |
| `reach_plan` | Create a short-lived exact-action plan with current policy hash, execution-identity lock, optional expected-identity preflight, and checkpoint attempt |
| `reach_commit_plan` | Commit one exact plan once; refuse stale, changed-client, changed-policy, changed-identity, or expired plans |
| `reach_receipts` | Read recent node-signed execution receipts and their tamper-evident hash chain |
| `reach_result_read` | Continue reading a large bounded result |
| `reach_revoke_node` | Revoke one node credential and disconnect that node |

The pinned compatibility package currently exposes 26 raw local tools to the node internally. DEX//REACH deliberately advertises only **22** of them to remote clients: safety-configuration mutation, compatibility call-history recovery, vendor feedback, and vendor onboarding/prompt tools are withheld. URL-fetch mode is also blocked, so `reach_call` cannot turn the node into a generic HTTP/SSRF proxy. DEX//REACH owns the gateway, authentication, routing, node policy, audit, native operations, and safety boundaries; `@wonderwhy-er/desktop-commander` remains a pinned local compatibility dependency while the remaining primitives are replaced incrementally.

---

## The Device Owner's Controls

The node enforces its access policy locally before **every** routed request.

```bash
npm run dex -- status
npm run dex -- disable
npm run dex -- read-only
npm run dex -- enable
npm run dex -- enable --for 30m
npm run dex -- read-only --for 2h
npm run dex -- client chatgpt off
npm run dex -- client claude read-only
npm run dex -- client chatgpt default
npm run dex -- audit --limit 50
npm run dex -- policy-check
npm run dex -- doctor
npm run dex -- doctor --json --deep
npm run dex -- doctor --share
npm run dex -- activity
npm run dex -- activity --watch
npm run dex -- activity --history
npm run dex -- assertions
npm run dex -- assertion add chatgpt --forbid process.shell --note "ChatGPT must never have shell"
npm run dex -- policy-history
npm run dex -- policy-restore 1
npm run dex -- grant chatgpt file.write --root "$HOME/projects" --for 20m --max-uses 6
npm run dex -- explain chatgpt dex.file.write --path "$HOME/projects/example.txt"
npm run dex -- grants
npm run dex -- budgets
npm run dex -- budget set chatgpt --window 1h --max-operations 40 --max-mutations 10 --max-shell 3
npm run dex -- budget clear chatgpt
npm run dex -- requests
npm run dex -- request create chatgpt file.write --root "$HOME/projects" --for 20m --max-uses 1 --justification "edit one project file"
npm run dex -- request approve <id>
npm run dex -- request deny <id>
npm run dex -- projects
npm run dex -- dirty
npm run dex -- project DEX-REACH info
npm run dex -- project Atlas_Of_One checkpoint
```

### Access modes

- **OFF** — all remote AI execution is refused locally.
- **READ-ONLY** — inspection is allowed through typed native operations and a deliberately tiny shell-free command grammar; shell composition, redirection, substitution, compatibility shell processes, writes, and mutating commands are refused.
- **ON** — the node's configured execution profile applies.
- **Timed access** — access automatically returns to the prior safe state when the window expires.
- **Per-client caps** — ChatGPT, Claude, or another client can be restricted independently. A client cap can only reduce access, never increase it.
- **Capability grants** — an enabled client can be switched into grant-required mode and limited to specific capabilities, filesystem roots, expiration times, and optional use counts. Grants never override OFF, READ-ONLY, or a stricter client ceiling.
- **Rolling execution budgets** — the owner can cap operations, mutations, shell calls, requested write bytes, requested process time, and inflight concurrency over a rolling window, shared and/or per client. Budgets only narrow remaining capacity. They never grant authority, and usage counters do not change the owner policy hash.
- **Capability requests** — AI may ask for a capability, roots, duration and optional use cap. That request is not authority. Only a local owner approval creates an ordinary capability grant, and the owner may narrow the request but cannot widen it.
- **Policy assertions** — `npm run dex -- policy-check` validates the local grant schema plus hard OFF and READ-ONLY invariants before owner-managed policy changes are accepted.

Newly enrolled second devices start **OFF**. Missing or corrupt access policy also means **OFF**.

None of the local enable/disable commands require the gateway or internet access.

---

## Shared-Machine Work Coordination

One computer often serves several AI sessions at once: a Claude Code session, a ChatGPT request through DEX, Codex, another agent, plus whatever the owner is doing. Terminal access is not ownership of the machine. DEX//REACH keeps a local work coordinator so those jobs queue instead of racing.

```bash
npm run dex -- work-status
npm run dex -- work-queue

npm run dex -- work-acquire \
  --repo "$HOME/DEX-REACH" \
  --access mutate \
  --workload heavy \
  --executor claude-code \
  --phase phase-0a

npm run dex -- work-heartbeat <lease-id>
npm run dex -- work-release <lease-id>
npm run dex -- work-wait <ticket-id>
npm run dex -- work-cancel <ticket-id>
```

`work-status` measures the actual host rather than assuming a machine specification, and prints the slot ceilings, live memory/CPU/thermal pressure, active leases, queue depth, and any substantial workloads running without a lease.

**What the coordinator decides.** Two rules do most of the work:

- **Only one mutating owner per repository.** A second agent asking to mutate the same repository is queued, including when it spells the path differently or reaches it through a symlink. Reads still proceed alongside.
- **Capacity is a ceiling, not a target.** Memory is the primary limiter and CPU the secondary one. A host at or under 12 GiB gets one substantive job; larger hosts scale up to a bounded number. Live memory pressure, CPU saturation, or thermal throttling queue new heavy work even when the static ceiling would allow it, and an unmeasurable reading is treated as a reason to wait rather than a reason to proceed.

Installation and deployment (`install:macos`, service replacement, credential or node-authentication migration) take `--access exclusive`, which requires an otherwise idle machine.

Jobs that carry no lease are still counted. Another agent's build or test run is visible in the process table and reduces available capacity as an **uncoordinated observed workload**. DEX reads only the process table for this; it never inspects another conversation's content, and a process it cannot attribute stays anonymous.

**What a lease is not.** A lease answers *can this run now?* It never answers *is this allowed?* Holding one grants no filesystem, process, or network authority and does not bypass OFF, READ-ONLY, client ceilings, grants, roots, budgets, or plan rules. A job can be authorized and still queued, and it can have machine capacity and still be refused. Both checks must pass. A lease record contains only coordination metadata — no prompts, no conversation content, no command output, no credentials — and lives under `~/.dex-reach/coordinator/`, outside Git.

**One machine, one coordination namespace.** Compatibility adapters intentionally run with an isolated `HOME` so their own configuration cannot pollute or mutate owner state. Coordinator and activity evidence do **not** follow that virtual HOME: unless `DEX_REACH_STATE_DIR` explicitly selects an isolated test/proof root, they resolve from the real OS account home. That keeps every execution path on one physical account in the same capacity/activity view while leaving authority-bearing policy, credentials, and secrets on their existing isolated state semantics.

**Staleness.** A lease heartbeats about every 30 seconds and becomes reclaimable only after several missed heartbeats *and* the recorded process being gone. Reclaiming means the coordination claim expired; it never terminates another process. A live process is never evicted for being slow. If your workflow has no long-lived process to name with `--pid`, heartbeat the lease or it expires after about two and a half minutes.

If coordinator state is unreadable or corrupt, admission falls back to a single substantive job rather than unlimited concurrency, and `work-status` reports the problem so the owner can repair it.

Waiting in the queue is a normal outcome, not a failure.

---

### Owner-visible activity

The coordinator answers whether work may run; the activity ledger answers what DEX is actually doing.

```bash
npm run dex -- activity
npm run dex -- activity --watch
npm run dex -- activity --history
npm run dex -- activity --json
npm run dex -- activity --share
```

The live view keeps four categories separate:

- **DEX-owned processes** — native process execution uses the actual spawned child PID; compatibility `start_process` uses the PID returned by the adapter.
- **Coordinated work** — leases and queue tickets show which agent/project/phase owns capacity. A lease acquired without an explicit `--pid` is labelled **workload PID unbound** instead of pretending the short-lived acquisition CLI is the workload.
- **DEX services** — the persistent gateway and node processes are shown separately.
- **Heavy processes not owned by DEX** — process-table observations that consume capacity but are not attributable to a DEX activity remain explicitly anonymous/unowned.

Persistent activity evidence stores bounded process identity and lifecycle metadata only. Raw commands, command arguments, prompts, transcripts, stdout/stderr and credentials are not stored. `--share` removes local PIDs and paths. Activity is evidence only: it does not grant authority or bypass owner policy.

## Execution Profiles

Owner modes are and remain exactly three: **OFF**, **READ-ONLY**, **ON**. A profile is a separate axis — a standing local constraint the machine owner configures on the node itself with `DEX_REACH_PROFILE`, which narrows what ON can reach on that machine. A remote client cannot choose one.

`workspace-safe` is the profile for typed project work without a shell.

| | workspace-safe |
| --- | --- |
| Inspection, file reads, repo info, receipts | allowed |
| Typed file writes | allowed |
| Checkpoints and planning | allowed |
| Declared-safe compatibility tools (read, list, search, write, edit, move, mkdir) | allowed |
| `dex.process.run`, arbitrary shell | refused |
| Process and session compatibility tools, terminate, kill | refused |
| Safety-configuration mutation and vendor surfaces | refused |
| Any adapter tool or operation the catalog does not classify | refused |

**The two axes compose by intersection, never by union.** Both must allow an operation for it to run. The profile constraint is evaluated against the node's own configured profile, not against the effective profile an authorization decision produced — READ-ONLY replaces that effective value, and reading the constraint from it would let READ-ONLY re-admit the very shell the owner configured this node to refuse. A narrowing must never widen.

So on a workspace-safe node: OFF refuses everything; READ-ONLY takes away the typed writes and checkpoints that workspace-safe adds, and does not hand back the shell; a client ceiling narrows a single client kind further; a grant narrows to named capabilities and roots. Each of those only subtracts.

A plan committed on a workspace-safe node inherits its target's admission, so a plan cannot be used to launder a refused operation past the profile. A plan issued before the owner narrowed the node is stale authority rather than grandfathered authority, and is refused against the profile in force now.

```bash
npm run dex -- explain claude dex.process.run
```

`explain` reports the policy decision and the profile constraint separately, and says whether the operation would actually run. A policy answer alone could contradict what the node does.

Adding this profile changes no installed node. Every node keeps the `DEX_REACH_PROFILE` it was configured with, and the default is still `development`.

---

## Causal Tracing

Every request carries a W3C Trace Context from the MCP edge through the gateway and node into authorization, planning, commit and execution. The node returns the `traceId` alongside the result, so a completed action can be reconstructed afterwards from evidence instead of from a description of what was supposed to happen.

```bash
npm run dex -- traces            # recent traces, newest first
npm run dex -- trace <trace-id>  # the ordered causal chain for one request
```

A trace shows the stages an action passed through, the operation, the node, the actor kind, whether each stage succeeded, and the hashes and identifiers that tie the stages together — the policy hash that authorized it, the request hash, the plan, checkpoint and receipt ids.

**What a span cannot carry.** Spans are an explicit allowlist of identifiers, stage, outcome and hashes. Arguments, file content, process output, raw plan arguments, tokens and credentials are structurally refused rather than filtered out after the fact. A refusal is traced as an outcome class only: the refusal message can quote a path or a command, so it is deliberately not traced, and the local audit log remains the place that holds the redacted detail.

**Inbound context.** A well-formed `traceparent` is continued so a caller's trace and DEX's evidence join up. A malformed one starts a fresh trace rather than being repaired or trusted. `tracestate` is accepted only when every member validates and the whole stays within the W3C bounds. `baggage` is never accepted at all: it is arbitrary caller-controlled key/value data, and a control plane has no reason to propagate it.

**Where it goes.** Traces are local, bounded, and outside Git, under `~/.dex-reach/traces/`. OpenTelemetry export is off unless the owner sets `DEX_REACH_OTEL_EXPORT=1`, and telemetry is never enabled by default.

Tracing observes decisions. It never makes one, and it grants no authority.

---

## Capability Adapters

DEX can route a call to third-party tooling — today, the pinned Desktop Commander compatibility adapter. An adapter is not a peer of the authority layer, and the contract between them is deliberately one-way.

An adapter **declares**, in a manifest, what each of its tools is: the DEX capability it requires, its risk class, whether it mutates, whether it can reach the network, which argument fields carry filesystem paths, whether `workspace-safe` admits it, whether it can be planned, whether it is withheld from remote clients, and what undoing it means. DEX holds its own catalog of the same facts, and a tool is admitted only when the declaration and the catalog agree on every one of them.

So a manifest can only ever *fail* to admit a tool. It cannot raise a tool's privileges, invent a capability, mark a shell tool workspace-safe, un-block a withheld tool, hide a path-bearing argument, or introduce a tool DEX has not classified. Each of those is a refusal, and a refusal aborts the whole install rather than admitting the rest: a partly admitted adapter is one whose surface DEX and its owner disagree about. An absent field is refused rather than defaulted, because the safe-looking default is exactly the one an incomplete manifest would benefit from.

**Adapters are installed locally, by the machine owner.** A remote client can ask which adapters are installed and call an admitted tool. There is no remote install, no remote update, no manifest edit, and no adapter-policy path at all.

**The wrapper does not launder capability.** `dc.call` names the `compat` capability, but the call it wraps does whatever the named tool does. A routed call now demands both — `compat` and the tool's own capability — so a grant holding `compat` alone can no longer write files or start processes through the adapter. A call naming no tool, or a tool DEX does not classify, demands every capability and therefore matches no grant.

**Identity is observed, not claimed.** The adapter's version and the hash of its entry point are read from disk at load time and recorded as evidence; the manifest's own claims about them are overwritten. An unreadable entry point records a null hash rather than an invented one.

The remote compatibility surface remains exactly the approved 22 of the adapter's 26 tools. Safety configuration, local call history and the vendor feedback and onboarding surfaces stay withheld, and are absent from the surface rather than merely refused, so probing cannot tell a withheld tool from one that does not exist.

---

## Node-Local Secrets (EXPERIMENTAL)

A remote AI can ask the node to run a command that needs a credential without ever being told the credential. The owner stores a value locally under an alias; the model names the alias.

```bash
npm run dex -- secret set deploy-token --env DEPLOY_TOKEN   # value is typed without echo, or piped in
npm run dex -- secrets                                      # aliases only, never values
npm run dex -- secret rm deploy-token
```

The value lives in `~/.dex-reach/nodes/<node>.secrets.json`, mode 0600, on the node. It is read after final authorization and immediately before the local invocation, injected into that one child process's environment, and scrubbed from what comes back. It is never resolved at the gateway, in MCP, when a request is created, or while a plan is being made, and it never appears in a plan, an audit entry, a receipt, a trace, a checkpoint, a `doctor --share` report or Git.

**Using a secret is its own authority.** `secret.use` is a separate capability. Holding `process.shell`, `file.write` and everything else combined does not let a client name a stored alias, and holding `secret.use` alone grants no shell to inject one into. That separation is the point: otherwise every shell grant would quietly have been a credential grant.

**A named alias is never silently dropped.** An unknown alias, an operation DEX cannot inject into, or a profile that does not inject at all is a refusal, not a command that runs without the credential it asked for. READ-ONLY and `workspace-safe` refuse injection outright — READ-ONLY admits inspection commands without consulting a capability grant at all, and an inspection command has no use for a credential.

**Remotely, a credential-bearing call must be planned.** No first-class MCP action takes a secret alias. The only remote route is `reach_plan`'s exact target arguments, so such a call is one-use, identity-bound and recorded before it runs rather than issued free-form.

**What this does not do.** It does not make arbitrary shell safe. A command holding a credential in its environment can do anything a command can do with it, including send it somewhere DEX cannot see. Output scrubbing removes a value echoed verbatim, which is the common accident; it cannot remove one the command encoded, split or forwarded. Controlled injection narrows where a value travels. It is not a reason to grant shell you would not otherwise grant.

This feature is **experimental**: it is proven by regression only, and no deployed node has brokered a secret.

---

## Portable Evidence

A completed action leaves a signed receipt on the node. `dex evidence export` turns a range of those, and the trace that links them, into one JSON file a third party can check offline.

```bash
npm run dex -- evidence export --trace <trace-id> --out bundle.json
npm run dex -- evidence verify bundle.json
```

A bundle carries identifiers, hashes, signed receipts, sanitized trace spans and its own list of limitations. It carries no file content, no standard output or error, no credentials, no private keys, no secret values, no raw owner policy and no raw request arguments. Verification reads the file and nothing else: no node, no network, no state directory.

**There is no overall VERIFIED, on purpose.** Different facts in a bundle are provable to very different degrees, and one word for all of them is how evidence gets over-read. Verification answers each claim separately and says what each answer does not mean:

```text
bundle integrity                PASS
receipt signatures              PASS
signing key consistency         PASS
node id consistency             PASS
node identity                   NOT PROVEN
receipt chain                   PASS
chain anchored to node genesis  NOT INCLUDED
bundle completeness             NOT PROVEN
trace linkage                   PASS
request hash                    NOT INCLUDED
execution output                NOT INCLUDED
external side effect            NOT PROVEN
```

Three of those never become PASS, whatever a bundle contains. **Node identity**: signatures verify against the key the bundle itself carries, so a forger can produce an internally flawless bundle with their own key; binding one to a real node means comparing its key fingerprint against a key you already trust, which only you can do. **Bundle completeness**: receipts removed from either end leave no gap, so an unbroken chain does not prove nothing was left out. **External side effect**: a receipt records what the node was asked to do and what it reported, not that a file, a repository or a remote system actually changed.

**Disclosures are opt-in.** A request hash cannot be recomputed without the arguments, and the arguments are what a privacy-preserving bundle withholds. When you are willing to state what was run, `--disclose` attaches it and the verifier recomputes the hash and compares, so a disclosure that understates what happened fails rather than being believed. Attaching one publishes those arguments.

---

## Release Provenance

A build that succeeds proves nothing about whether anyone else can reproduce it. `npm run verify:clean-build` answers the question that matters: are the artifacts in `dist/` a function of the tracked source at this commit, and nothing else?

```bash
npm run verify:clean-build     # rebuild this commit from git archive and compare, file by file
npm run release:provenance     # full manifest: checks, checksums, SBOM, platform claims
```

The comparison exports the commit with `git archive`, installs from `package-lock.json` alone, and builds in a directory with a different absolute path and no pre-existing output. That catches four things a green build hides: an untracked file the build reads, a stale artifact left over from a module that no longer exists, a globally installed package the workflow never installs, and an absolute path or timestamp baked into the output. A difference names the file and its likely cause. It runs as its own CI job, so a failure there is not mistaken for a test or audit failure.

`release:provenance` writes `release/manifest.json`, `release/checksums.txt` and a CycloneDX `release/sbom.cdx.json`. The manifest records the exact commit, whether the working tree was clean, the toolchain, every check with its result, a SHA-256 for each artifact, and a hash of the SBOM normalized so two builds of one dependency tree hash alike.

**It states what it did not do.** A check that could not run is recorded with its reason rather than omitted, because a missing line reads as "fine" to everyone who was not there. `live deployment` is always UNVERIFIED: nothing in a build exercises a deployed gateway, an installed service or a real MCP client session. macOS, Android and second-machine claims read `UNVERIFIED — HARDWARE NOT AVAILABLE` unless the checks genuinely ran there. And reproducibility does not mean correctness: a compromised upstream package produces a perfectly reproducible build of compromised code.

The project licence is unchanged and is not chosen by this tooling.

---

## Physical and Runtime Proof

Everything above is a claim about behaviour. `npm run proof` is the answer to "prove it here, now":

```bash
npm run proof              # every proof this machine can establish; the rest recorded as unverified
npm run proof -- --json    # the same run as a machine-readable artifact
npm run proof -- --no-live # skip the live gateway/node pair
npm run proof -- --require-live  # fail if the pair cannot start, instead of recording it unverified
```

It starts a **real gateway and a real node agent as separate OS processes**, enrolls the node, completes the Ed25519 enrollment ceremony, connects a real MCP client through the full OAuth flow, and drives owner policy from the CLI while that client watches what happens. Nothing is stubbed and nothing is reused from a previous run. It works entirely inside a temporary state directory on a loopback port, so it never touches an existing install and never contacts a deployed gateway.

Nineteen proofs are required before DEX//REACH may be called physically proven. Each one names the single environment that can establish it, and what a pass still does **not** establish:

| Environment | What it can establish |
| --- | --- |
| `this-process` | Policy, profiles, grants, budgets, receipts, traces and evidence, against the real modules |
| `local-pair` | Routing, transport authentication, end-to-end refusal, the kill switch, revocation and recovery |
| `macos-host` | A real install of the launchd service on a host its owner offered |
| `android-device` | ADB operations against a physically attached phone |
| `second-machine` | That two physically separate machines stay distinct |

**An absent environment can never produce a pass.** A result reported for hardware that was not present is discarded, and the report says it was discarded — the line reads `UNVERIFIED — HARDWARE NOT AVAILABLE` with the reason. An item nobody attempted says so rather than being left out. Unverified is a third outcome, not a soft failure: no Android device attached is not evidence that ADB handling is broken, and recording it red would teach you to ignore red lines on the day one of them is real. The run exits non-zero only on a genuine failure.

Two defects came out of the first executed run, neither of which any source test could have seen: a gateway whose OAuth discovery document advertised RFC 9207 support while its own approval route omitted the `iss` parameter, which stopped every spec-compliant MCP client at the callback; and a re-enrolled node that retried a transport proof the gateway had forgotten, forever, with nothing in either log saying why.

It also checks the served contract itself: a real OAuth/PKCE client listing exactly the 16 first-class actions, exactly the 22-tool compatibility surface with the 4 withheld tools absent rather than refused, and a trust report that scopes its own verdict. That is stronger than the source-level contract test it supplements, and it is still not the deployed HTTPS gateway, so the PROOF STALE marks in `docs/INVARIANTS.md` stand.

Current state on a Linux container: **18 of the 19 required proofs established**, with `fresh-node-install` unverified because it needs a macOS host its owner authorizes with `DEX_REACH_PROOF_ALLOW_INSTALL=1`. That is not the same as proven on the owner's Mac, and this tooling does not say otherwise.

---

## Install and Run

### Requirements

- Node.js 22 or newer
- npm
- macOS for the currently verified persistent-service path
- Linux systemd user-unit generation is implemented, but it has not yet been verified on real Linux hardware
- Windows is not currently supported for `dex.process.run`

### Local development / gateway setup

```bash
npm install
npm run bootstrap -- --public-url http://127.0.0.1:8787
npm run gateway
# separate terminal
npm run node
# separate terminal
npm run smoke
```

Persistent gateway/primary-node installation on macOS:

```bash
npm run install:macos
```

The installer stages and syntax-checks both LaunchAgents first, then hands their replacement to a separate one-shot launchd helper. This makes `install:macos` safe to invoke through DEX//REACH itself: the command returns before the gateway/node transport is deliberately cycled. A brief disconnect while the services restart is expected; the helper records its final result at `~/.dex-reach/install-macos.status.json`.

### macOS Dock launcher

On the primary Mac, install the one-click Dock launcher with:

```bash
npm run install:dock
```

This builds and ad-hoc signs `~/Applications/DEX REACH.app`, verifies the exact Dock tile, and launches it once. The app is a tiny local shell bundle—not an AppleScript automation shim—so it needs no Terminal-control permission. Each click opens a **new Terminal instance** running the DEX//REACH control console. The console shows service health and local policy, can non-destructively restore already-installed LaunchAgents, and exposes the kill switch, timed READ-ONLY/ON windows, policy check, audit, signed receipts, grants, and a DEX-CLI prompt. Opening the launcher never changes OFF / READ-ONLY / ON, client ceilings, grants, credentials, roots, or profile by itself.

Gateway owner credentials and node credentials are kept outside the repository under `~/.dex-reach/` with mode `0600` files.

For ChatGPT or Claude, keep the gateway bound to localhost and place HTTPS in front of it. The current deployment uses Tailscale Funnel. Expose only the authenticated MCP gateway — never a raw shell port.

---

## Add a Second Device

A second machine gets its **own** node ID, credential, allowed roots, execution profile, policy file, and locally detected fingerprint.

### 1. Gateway owner enrolls it

```bash
npm run nodes -- enroll second-laptop --profile development
```

This creates a private node environment file under `~/.dex-reach/nodes/`. Transfer that file privately to the device owner. Do not put it in Git, ChatGPT, email, or a public paste.

Working nodes can later migrate to Ed25519 transport authentication without a flag-day. That keypair is not the receipt-signing key. The owner issues a one-use enrollment token (`npm run nodes -- enroll-token <node>`), the node creates the private key locally, and `complete-migration` disables bearer tokens. Gateway state stores only the public key. File-backed 0600 storage is the proven local store; Keychain-backed storage is not claimed.

### 2. Device owner installs the node

```bash
git clone https://github.com/westkitty/DEX-REACH.git
cd DEX-REACH
npm ci
npm run install:node -- --env /path/to/second-laptop.env --roots "$HOME/projects" --service
```

On macOS, the node-only service installer also stages and validates its LaunchAgent before handing replacement to a one-shot helper, so an already-running node can update itself without depending on the request it is about to replace. Remote node gateway URLs must use `wss://`; only loopback may use cleartext `ws://`.

The source repository is public, so no repository invitation is required. Public source access does **not** enroll a device or grant access to any gateway: the separately generated node environment file is still a secret and must be transferred privately.

The node starts with AI access **OFF**.

### 3. Device owner chooses when to allow access

```bash
npm run dex -- status
npm run dex -- read-only --for 30m
# or
npm run dex -- enable --for 30m
```

### 4. Shut it off whenever wanted

```bash
npm run dex -- disable
```

That switch is local, survives reconnects/restarts, and does not require the gateway owner to cooperate.

For the short install-only version, read [`docs/SECOND_DEVICE_QUICKSTART.md`](docs/SECOND_DEVICE_QUICKSTART.md).

---

## Security & Privacy

DEX//REACH is designed around the assumption that AI clients should **not** be trusted as the final security boundary.

- Node policy is enforced on the node, not merely in ChatGPT settings.
- Nodes connect outbound and open no remote shell listener.
- Each node has an independent credential that can be rotated or revoked without affecting other nodes.
- Every operation is explicitly node-scoped.
- Typed file operations, checkpoints, read-only process arguments, and compatibility-tool path arguments are constrained to configured allowed roots. Existing symlinks are canonicalized before the scope decision, and plural/nested compatibility path arguments are inspected rather than silently skipped.
- DEX private state under `~/.dex-reach/` (or a configured state directory) is explicitly excluded from path-scoped remote operations even when a broader allowed root contains it; relative path arguments are refused rather than ambiguously resolved.
- Compatibility safety configuration is node-owned. Remote clients cannot call `set_config_value`, recover Desktop Commander call history, invoke vendor feedback/onboarding tools, or use compatibility URL-fetch mode.
- READ-ONLY process execution is shell-free: accepted inspection commands are executed directly with argv rather than through `sh -lc`/`zsh -lc`, preventing command chaining, substitutions, and redirections from smuggling mutations through the read-only gate.
- ON-mode `reach_process_run` is intentionally an arbitrary-shell capability. Allowed roots constrain its working directory but are **not an OS sandbox** for arbitrary shell programs; use capability grants, a restrictive execution profile, and OS isolation when stronger confinement is required. Child processes do not inherit DEX credential variables or other obvious secret-bearing environment variables, and known parent secret values are redacted from returned stdout/stderr.
- Exact-action plans bind a mutation to a node, client, request hash, policy hash, short expiry, one-use state, and an attempted pre-mutation Git checkpoint. Concurrent claims admit only one executor; raw plan arguments are scrubbed after claim or expiry.
- Every node request produces a local Ed25519-signed receipt containing hashes and policy/actor metadata rather than file contents or credentials; receipts form a predecessor hash chain.
- Destructive command patterns such as `sudo`, `rm -rf`, disk formatting, shutdown/reboot, destructive Git cleanup/reset, and force-push are blocked.
- Results are bounded; large responses use continuation handles.
- Credentials/tokens are redacted from audit logs. Bootstrap, revocation, policy, plan, receipt, OAuth, and credential state writes use bounded atomic/locked update paths where concurrent writers could otherwise corrupt authority state.
- A non-loopback public MCP identity must use HTTPS. A node may use `ws://` only to loopback; a remote gateway WebSocket must use `wss://`.
- File contents are not copied into the local audit trail; operations are summarized instead.
- AI-client attribution is recorded when available from the approved OAuth client identity.

When access is ON, prompt-injection and compromised-client risk still exist. The point of DEX//REACH is not to pretend otherwise; it gives the machine owner a local boundary, smaller blast radius, auditability, and an immediate kill switch.

Read the plain-language threat model in [`docs/TRUST_AND_PRIVACY.md`](docs/TRUST_AND_PRIVACY.md). Report suspected vulnerabilities through the private process in [`SECURITY.md`](SECURITY.md), not a public issue.

---

## Basic Usage from an AI Client

A normal safe sequence is:

1. `reach_list_nodes`
2. choose the exact `node_id`
3. call `reach_trust_report` for a fresh runtime trust certificate; use `reach_fingerprint` when you need the raw identity record
4. for consequential mutation, call `reach_plan` with the exact target operation and arguments and, when you already know the intended environment, an `expected_identity` constraint
5. commit that plan once with `reach_commit_plan` (or use a direct mutation only when transactional binding is unnecessary)
6. inspect the returned result and, when proof matters, `reach_receipts`

Example intent:

```text
Using DEX//REACH, list the available nodes.
Then use only second-laptop, get its execution fingerprint,
and read /Users/device-owner/projects/example/README.md.
Do not use any other node.
```

Every successful `reach_plan` captures the fresh execution fingerprint and binds it into the plan. `reach_commit_plan` re-captures that identity immediately before mutation and refuses execution if the machine, user, working directory, repository root, branch, remote, platform, architecture, or Node runtime changed. `expected_identity` adds a caller-supplied preflight on top of that automatic drift lock.

If the target node is OFF, read-only for a mutation, offline, unknown, revoked, or no longer matches a planned execution identity, DEX//REACH returns an error. It does not silently choose another computer.

---

## Verification

Primary deterministic source/build gate:

```bash
npm run verify
```

The machine-consumable release-invariant index can also be emitted directly:

```bash
npm run invariants
```

Full deployed golden-worker gate:

```bash
npm run verify:golden
```

`npm run verify` runs typecheck, the machine invariant-manifest check, the complete regression suite, production build, production dependency audit, and the raw compatibility-backend probe. `npm run verify:golden` adds the live public OAuth/PKCE MCP smoke. The smoke verifies all 16 first-class tools and metadata, the evidence-scoped trust report, deployed node version, the exact 22-tool safe compatibility surface, blocked safety/history/vendor/URL-proxy paths, telemetry/allowed-root policy, child-process credential-environment sanitization, ADB availability, native file/process execution, rejected mismatched execution identity, identity-bound plan→commit, signed receipts, and reversible checkpoint behavior. See [`docs/GOLDEN_WORKER.md`](docs/GOLDEN_WORKER.md) for the end-to-end release path including persistent install and Dock proof.

`scripts/sim-two-nodes.ts` drives a second isolated node through the live gateway and verifies multi-node routing, roots, access modes, client caps, audit attribution, credential isolation, and no-fallback behavior.

Real ChatGPT and Claude policy-refusal paths have also been exercised; the authoritative proof record is maintained in [`OPERATIONAL_STATE.md`](OPERATIONAL_STATE.md).

---

## Development Workflow

Useful commands:

```bash
npm run verify
npm run verify:golden
npm run install:macos
npm run install:dock
npm run gateway
npm run node
npm run nodes -- list
npm run dex -- status
```

Before changing execution, routing, authentication, policy, or install behavior, read `OPERATIONAL_STATE.md` and preserve its active invariants.

---

## Repository Layout

```text
.
├── src/
│   ├── gateway/          # OAuth, MCP server, node registry, routing, audit
│   ├── node/             # node connection, native execution, local enforcement
│   │   └── adapters/     # capability adapters and their declared manifests
│   └── shared/           # protocol, access policy, operation catalog, adapter contract, execution profiles, guardrails, work coordination, tracing
├── scripts/              # bootstrap, install, credentials, smoke, simulations, local CLI
├── tests/                # access, auth, routing, security, native, audit, result-store, coordinator tests
├── docs/
│   ├── GOLDEN_WORKER.md
│   ├── INVARIANTS.md
│   ├── INCIDENT_PREVENTION.md
│   ├── TERMINAL_COMMANDS.md
│   ├── SECOND_DEVICE_QUICKSTART.md
│   └── TRUST_AND_PRIVACY.md
├── OPERATIONAL_STATE.md  # authoritative current state and verification evidence
├── ATTRIBUTION.md
├── SECURITY.md
├── package.json
└── README.md
```

---

## For AI Agents and Maintainers

If you are an AI taking over this project, do not infer completion from source presence alone.

1. Read this README for purpose and architecture.
2. Read [`OPERATIONAL_STATE.md`](OPERATIONAL_STATE.md) for the current verified/unknown/pending state.
3. Preserve node-local authority, explicit `node_id` routing, credential isolation, allowed-root enforcement, and fail-closed behavior.
4. Never turn simulated second-device evidence into a claim that a physical second machine was verified.
5. Run the repository quality gate before making completion claims.
6. Keep secrets under `~/.dex-reach/` out of Git, logs, prompts, and documentation.
7. Do not force-push or silently widen filesystem/process permissions.

The README explains the system. `OPERATIONAL_STATE.md` controls what is actually considered proven.

---

## Known Limits

- No second physical machine has been enrolled yet; second-node behavior is verified through a real isolated node process and real AI clients, not separate hardware.
- Linux service installation is implemented but has not been run on a real Linux host.
- Windows process execution and service installation are not implemented.
- Real Android hardware has been verified through DEX//REACH on a Samsung SM-X910 using harmless wireless-ADB discovery and identity reads; destructive/device-mutating ADB behavior was not exercised.
- Some local capabilities still come from the pinned Desktop Commander npm package through the compatibility adapter. The package has 26 raw internal tools; DEX currently exposes 22 remotely after withholding node-owned/vendor/history surfaces. The external Desktop Commander relay/app is not required by DEX//REACH.

---

## Additional Documentation

- [Operational state / verification record](OPERATIONAL_STATE.md)
- [Golden-worker verification and release proof](docs/GOLDEN_WORKER.md)
- [Protected capability invariants](docs/INVARIANTS.md)
- [Incident prevention notes](docs/INCIDENT_PREVENTION.md)
- [Terminal command reference](docs/TERMINAL_COMMANDS.md)
- [Trust and privacy, plainly](docs/TRUST_AND_PRIVACY.md)
- [Security policy and vulnerability reporting](SECURITY.md)
- [Second-device quickstart](docs/SECOND_DEVICE_QUICKSTART.md)
- [Third-party attribution](ATTRIBUTION.md)

---

## License status

The repository is publicly readable, but no open-source license file is currently declared. Package metadata is therefore marked `UNLICENSED`; public source visibility by itself is not treated as a license grant.

---

## Final Note

DEX//REACH is not trying to make an AI trustworthy.

It is trying to make trust **bounded, visible, revocable, machine-specific, and owned by the person whose computer is actually doing the work**.

That distinction is the whole project.
