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
| Capability grants + policy assertions | **Implemented and unit-verified in 0.3.0; deployed-client proof pending** |
| Exact-action plan/commit + signed receipts | **Implemented and unit-verified in 0.3.0; deployed-client proof pending** |
| Two-node routing and policy isolation | **Verified** with a live isolated second-node simulation |
| Second physical device | **Ready for install, not yet hardware-verified** |
| macOS node service install | **Implemented; node-only install still needs fresh-machine physical proof** |
| Linux systemd path | **Implemented, not yet tested on a real Linux host** |
| Windows process execution | **Not supported yet** |
| Android ADB discovery | **Verified**; real device-control proof still pending |

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

DEX//REACH currently exposes 15 first-class MCP actions:

| Action | Purpose |
| --- | --- |
| `reach_list_nodes` | List enrolled machines, online state, identity, profile, roots, and local AI-access state |
| `reach_list_tools` | List compatibility-adapter tools available on one selected node |
| `reach_call` | Invoke one compatibility tool on one explicit node |
| `reach_fingerprint` | Prove which physical/runtime environment will execute work |
| `reach_repo_info` | Inspect Git repository state without mutating it |
| `reach_adb_devices` | Discover Android devices visible to a node through ADB |
| `reach_checkpoint` | Capture a reversible Git worktree checkpoint |
| `reach_file_read` | Read a bounded UTF-8 file inside the node's allowed roots |
| `reach_file_write` | Write or append UTF-8 text inside allowed roots |
| `reach_process_run` | Run a bounded guarded shell command on the selected node |
| `reach_plan` | Create a short-lived exact-action plan with current policy hash and checkpoint attempt |
| `reach_commit_plan` | Commit one exact plan once; refuse stale, changed-client, changed-policy, or expired plans |
| `reach_receipts` | Read recent node-signed execution receipts and their tamper-evident hash chain |
| `reach_result_read` | Continue reading a large bounded result |
| `reach_revoke_node` | Revoke one node credential and disconnect that node |

The compatibility path currently contributes 26 additional local tools for search, edits, filesystem operations, and interactive process sessions. DEX//REACH owns the gateway, authentication, routing, node policy, audit, native operations, and safety boundaries; `@wonderwhy-er/desktop-commander` remains a pinned local compatibility dependency while those remaining primitives are replaced incrementally.

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
npm run dex -- grant chatgpt file.write --root "$HOME/projects" --for 20m --max-uses 6
npm run dex -- explain chatgpt dex.file.write --path "$HOME/projects/example.txt"
npm run dex -- grants
```

### Access modes

- **OFF** — all remote AI execution is refused locally.
- **READ-ONLY** — inspection is allowed through typed native operations and a deliberately tiny shell-free command grammar; shell composition, redirection, substitution, compatibility shell processes, writes, and mutating commands are refused.
- **ON** — the node's configured execution profile applies.
- **Timed access** — access automatically returns to the prior safe state when the window expires.
- **Per-client caps** — ChatGPT, Claude, or another client can be restricted independently. A client cap can only reduce access, never increase it.
- **Capability grants** — an enabled client can be switched into grant-required mode and limited to specific capabilities, filesystem roots, expiration times, and optional use counts. Grants never override OFF, READ-ONLY, or a stricter client ceiling.
- **Policy assertions** — `npm run dex -- policy-check` validates the local grant schema plus hard OFF and READ-ONLY invariants before owner-managed policy changes are accepted.

Newly enrolled second devices start **OFF**. Missing or corrupt access policy also means **OFF**.

None of the local enable/disable commands require the gateway or internet access.

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

### 2. Device owner installs the node

```bash
git clone https://github.com/westkitty/DEX-REACH.git
cd DEX-REACH
npm ci
npm run install:node -- --env /path/to/second-laptop.env --roots "$HOME/projects" --service
```

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
- Typed file operations, checkpoints, read-only process arguments, and compatibility-tool path arguments are constrained to configured allowed roots.
- DEX private state under `~/.dex-reach/` is explicitly excluded from path-scoped remote operations even when a broader allowed root contains it; relative path arguments are refused rather than ambiguously resolved.
- READ-ONLY process execution is shell-free: accepted inspection commands are executed directly with argv rather than through `sh -lc`/`zsh -lc`, preventing command chaining, substitutions, and redirections from smuggling mutations through the read-only gate.
- ON-mode `reach_process_run` is intentionally an arbitrary-shell capability. Allowed roots constrain its working directory but are **not an OS sandbox** for arbitrary shell programs; use capability grants, a restrictive execution profile, and OS isolation when stronger confinement is required.
- Exact-action plans bind a mutation to a node, client, request hash, policy hash, short expiry, one-use state, and an attempted pre-mutation Git checkpoint.
- Every node request produces a local Ed25519-signed receipt containing hashes and policy/actor metadata rather than file contents or credentials; receipts form a predecessor hash chain.
- Destructive command patterns such as `sudo`, `rm -rf`, disk formatting, shutdown/reboot, destructive Git cleanup/reset, and force-push are blocked.
- Results are bounded; large responses use continuation handles.
- Credentials/tokens are redacted from audit logs.
- File contents are not copied into the local audit trail; operations are summarized instead.
- AI-client attribution is recorded when available from the approved OAuth client identity.

When access is ON, prompt-injection and compromised-client risk still exist. The point of DEX//REACH is not to pretend otherwise; it gives the machine owner a local boundary, smaller blast radius, auditability, and an immediate kill switch.

Read the plain-language threat model in [`docs/TRUST_AND_PRIVACY.md`](docs/TRUST_AND_PRIVACY.md). Report suspected vulnerabilities through the private process in [`SECURITY.md`](SECURITY.md), not a public issue.

---

## Basic Usage from an AI Client

A normal safe sequence is:

1. `reach_list_nodes`
2. choose the exact `node_id`
3. `reach_fingerprint` if execution identity matters
4. for consequential mutation, call `reach_plan` with the exact target operation and arguments
5. commit that plan once with `reach_commit_plan` (or use a direct mutation only when transactional binding is unnecessary)
6. inspect the returned result and, when proof matters, `reach_receipts`

Example intent:

```text
Using DEX//REACH, list the available nodes.
Then use only second-laptop, get its execution fingerprint,
and read /Users/device-owner/projects/example/README.md.
Do not use any other node.
```

If the target node is OFF, read-only for a mutation, offline, unknown, or revoked, DEX//REACH returns an error. It does not silently choose another computer.

---

## Verification

Primary quality gate:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
npm run probe:backend
npm run smoke
```

`npm run smoke` exercises the public OAuth/PKCE MCP path, verifies all 15 first-class tools are advertised with metadata, and exercises compatibility routing, native file/process operations, ADB discovery, and reversible checkpoint behavior.

`scripts/sim-two-nodes.ts` drives a second isolated node through the live gateway and verifies multi-node routing, roots, access modes, client caps, audit attribution, credential isolation, and no-fallback behavior.

Real ChatGPT and Claude policy-refusal paths have also been exercised; the authoritative proof record is maintained in [`OPERATIONAL_STATE.md`](OPERATIONAL_STATE.md).

---

## Development Workflow

Useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run smoke
npm run probe:backend
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
│   └── shared/           # protocol, access policy, guardrails, shared helpers
├── scripts/              # bootstrap, install, credentials, smoke, simulations, local CLI
├── tests/                # access, auth, routing, security, native, audit, result-store tests
├── docs/
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
- ADB discovery works through DEX//REACH, but real Android hardware control is not yet verified.
- Capability grants, exact-action plan/commit, and signed receipts are implemented and unit-tested in 0.3.0; public deployed-client runtime proof is tracked separately in `OPERATIONAL_STATE.md`.
- Some local capabilities still come from the pinned Desktop Commander npm package through the compatibility adapter. The external Desktop Commander relay/app is not required by DEX//REACH.

---

## Additional Documentation

- [Operational state / verification record](OPERATIONAL_STATE.md)
- [Trust and privacy, plainly](docs/TRUST_AND_PRIVACY.md)
- [Security policy and vulnerability reporting](SECURITY.md)
- [Second-device quickstart](docs/SECOND_DEVICE_QUICKSTART.md)
- [Third-party attribution](ATTRIBUTION.md)

---

## Final Note

DEX//REACH is not trying to make an AI trustworthy.

It is trying to make trust **bounded, visible, revocable, machine-specific, and owned by the person whose computer is actually doing the work**.

That distinction is the whole project.
