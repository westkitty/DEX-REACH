# DEX//REACH Operational State

<!-- operational-state:metadata
{"schema_version":1,"project_id":"dex-reach","project_name":"DEX//REACH","project_root":".","artifact_path":"","state_revision":8,"last_updated":"2026-09-16T11:10:55Z","current_baseline":{"identity":"DEX//REACH 0.3.0 source-security / capability-grants / exact-plan / signed-receipts candidate on main","state":"implemented-unit-verified","last_verified":"2026-09-16T11:10:55Z"},"scope_boundaries":["DEX//REACH gateway, node agent, MCP interface, local service install, project docs"],"linked_parent_state":null}
-->

## 1. Project Identity and Scope
DEX//REACH is a secure AI-native remote-computing control plane intended to replace the useful Remote Desktop Commander workflow without depending on its hosted relay.

## 2. Current Baseline
Public source repository at `https://github.com/westkitty/DEX-REACH`. A macOS gateway and primary node are installed as user `launchd` services in the verified deployment. Public HTTPS ingress is active through Tailscale Funnel; the exact deployment hostname and client identifiers are intentionally kept outside the public repository. The primary node uses its own mode-0600 credential file, gateway authentication is keyed by node ID with persisted token hashes, and the ChatGPT Business workspace app is OAuth-linked, exposes all 12 MCP actions, and has passed real-client parity tests.

Every node now enforces a local AI access policy (`off` / `read-only` / `on`, timed windows, per-client caps) before executing any routed request; the gateway forwards a non-secret actor identity (client kind/id/name from the approved OAuth registration) and displays each node's policy. Local control CLI: `npm run dex -- status|enable|read-only|disable|client|audit|uninstall`. Second-device path: `npm run nodes -- enroll <id>` → private transfer → `npm run install:node -- --env <file> --service` (starts `off`).

Repository version 0.3.0 adds a stricter source-level control plane without changing the owner-authority model: READ-ONLY native process execution is shell-free and compatibility calls use an explicit inspection allowlist; capability grants can require a client to hold a capability/root/expiry/use-bounded lease; owner policy writes run built-in assertions; `reach_plan` / `reach_commit_plan` bind consequential work to an exact node, client, request, policy hash, expiry, one-use state, and checkpoint attempt; and nodes create local Ed25519-signed hash-chained execution receipts containing hashes rather than request/result contents. These 0.3.0 paths are source/unit verified in this revision but have not yet replaced the currently installed 0.2.0 public services, so the existing 12-tool real-client proof remains historical deployment evidence rather than proof of the new 15-tool surface.

## 3. Artifact Contract
Provide filesystem, search/edit, terminal/process, development/Git, multi-node routing, MCP access, authentication/revocation, bounded output, auditability, ADB discovery, recovery primitives, and persistent local operation.

## 4. Active Invariants
- INV-001: Do not disable the incumbent Remote Desktop Commander before actual ChatGPT/Claude parity proof.
- INV-002: DEX//REACH owns its gateway, node protocol, routing, authorization, and audit architecture.
- INV-003: Telemetry is off in the isolated compatibility backend; credentials and secrets never enter Git or audit logs.
- INV-004: Remote operations are explicitly node-scoped and path/capability bounded.
- INV-005: Only the authenticated gateway is publicly proxied; raw shell and node sockets are not directly exposed.
- INV-006: Node credentials are independent; rotating or revoking one node must not invalidate unrelated nodes.
- INV-007: DEX-native operations must enforce the same allowed-root and command guardrails as compatibility calls.
- INV-008: The node is the final authority. Node-local policy (off/read-only/on, timed windows, per-client caps) is evaluated on the node before every request; the gateway has no bypass. Absent or corrupt policy = off. A newly enrolled node starts off.
- INV-009: Routing is explicit: every operation names a node_id; unknown, blank, offline, or revoked IDs fail; there is no default node and no fallback.
- INV-010: Public source access grants no runtime authority. Gateway owner credentials, node enrollment files, tokens, policies, and deployment state remain outside Git; a node joins only with a separately generated per-node credential.
- INV-011: READ-ONLY never interprets an arbitrary shell program. Native inspection uses a strict shell-free argv grammar; compatibility calls use an explicit read-only allowlist and unknown compatibility tools fail closed.
- INV-012: Capability grants can only narrow an enabled client. They never override OFF, READ-ONLY, a stricter per-client ceiling, or the node's configured allowed roots.
- INV-013: Transactional execution plans bind node, client identity, exact operation/arguments, policy hash, expiry, and one-use state; a changed policy or client invalidates the commit path.
- INV-014: Execution receipts are signed by a node-local key and omit raw request/result contents and credentials. Gateway or client claims do not substitute for node receipt evidence.
- INV-015: DEX private state (`~/.dex-reach/` or the configured state directory) is never an addressable path-scoped remote resource merely because a broader allowed root contains it; relative path arguments fail closed.
## 5. Verified Working Behavior
- VER-001: Pinned Desktop Commander 0.2.50 is driven through the official MCP SDK and exposes 26 local tools.
- VER-002: Gateway and node run persistently under `launchd`; health reports one online Mac node.
- VER-003: OAuth dynamic registration, owner approval, PKCE, token exchange, stateful MCP, node routing, file roundtrip, and process execution pass through the public HTTPS endpoint.
- VER-004: Gateway restart terminates node sockets and the node automatically re-registers with the replacement gateway.
- VER-005: Strict typecheck, production build, regression tests, and npm audit with 0 vulnerabilities pass.
- VER-006: Per-node credential migration and live rotation are verified; the Mac reconnects with a new token without restarting the gateway, and the prior token expires after the grace window.
- VER-007: Public MCP smoke verifies 12 tools including DEX-native file read/write, guarded process execution, ADB discovery, and checkpoint creation from tracked plus untracked dirty Git state.
- VER-008: Claude Code has DEX//REACH registered at user scope and completed DEX OAuth/PKCE authentication; `claude mcp get dex-reach` reports Connected.
- VER-009: ChatGPT workspace app handshake observed end to end in gateway logs: DCR → `/authorize` (scope `mcp:tools`, PKCE S256, resource `/mcp`) → owner approval → `/token` 200 → `initialize` → `notifications/initialized` → `tools/list` (client `openai-mcp/1.0.0`, protocol 2025-11-25). ChatGPT's admin backend reports 12 actions with titles and read/write classification.
- VER-010: Real ChatGPT parity: node discovery, fingerprint, bounded file write/read, and guarded process execution completed through the deployed app. Writes prompted ChatGPT's Allow/Deny approval as configured (`ask_before_writes`); reads ran without prompts. Exact deployment identifiers and local paths are retained outside the public repository.
- VER-012: Node-local policy enforced end to end through the real ChatGPT app against an isolated second node: OFF refused fingerprinting; READ-ONLY allowed fingerprinting and refused a write; the enabled primary node still served an allowed read in the same turn. Refusals were recorded in the simulated node's audit with `actor.kind=chatgpt`.
- VER-013: Same policy applied to Claude Code (this session's `dex-reach` MCP server): write to the read-only sim node refused with the owner-attributed error, fingerprint succeeded, `pwd` on `macbook-air.local` succeeded.
- VER-014: Two-node simulation (`scripts/sim-two-nodes.ts`, 24 checks, public OAuth+MCP path): both nodes listed with distinct roots; OFF refuses all and creates nothing; READ-ONLY allows inspection commands and refuses writes/mutating commands; ON writes land only under the sim root and path escapes are refused; per-client cap (`smoke: off` / `read-only`) blocks/limits only that client kind; typo/unknown node IDs fail with no fallback; sim audit attributes the actor, omits file content, records refusals. Live rotate of the sim credential and CLI revoke left `macbook-air.local` connected and working; the revoked sim node was dropped by the gateway sweep and could not reconnect (502 on upgrade).
- VER-015: Local CLI on the sim node: `enable --for 5s` reverted to off after expiry; `client chatgpt off` + `read-only` displayed as `ChatGPT blocked (limit: off)`; `audit` listed refusals with client attribution and no file contents. Absent-policy fail-closed and corrupt-policy fail-closed covered by unit tests.
- VER-016: Gateway restart recovery with the new session handling: unknown MCP sessions now return 404, and Claude Code re-initialized transparently after a restart (previously a dead session persisted with 400).
- VER-011: Claude-issued DEX tool invocation verified: a Claude Code session called `reach_list_nodes` through the public MCP endpoint and received the live node record.
- VER-017: 0.3.0 source/unit verification covers the prior READ-ONLY shell-composition/root-escape class: shell operators/substitution, absolute paths outside configured roots, relative traversal, unknown compatibility tools, and interactive compatibility mutation paths are refused; approved direct inspection remains allowed.
- VER-018: 0.3.0 source/unit verification covers capability grants by client, capability, root, expiry/use budget, OFF precedence, and transactional policy validation before local policy writes.
- VER-019: 0.3.0 source/unit verification covers exact one-use execution-plan records plus Ed25519-signed receipt verification, predecessor hash chaining, and omission of raw request contents from receipt storage.

## 6. Known Not Working
None in the verified local/public SDK path or the ChatGPT real-client path.

## 7. Implemented but Unverified
- UNV-001: ADB discovery is verified through public MCP, but no Android hardware is currently attached or discoverable by mDNS, so device-control behavior remains unverified.
- UNV-002: (resolved → VER-011) Claude-issued invocation verified from a Claude Code session.
- UNV-003: No second physical device has been enrolled. Everything multi-node was proven with a second node process under an isolated state directory on the primary Mac. No operating-system-specific claim is made for an untested second device.
- UNV-004: Linux systemd user-unit generation (`install:node --service` on linux) is implemented and shape-tested but has never run on a Linux host. Windows: no installer, `dex.process.run` refuses win32.
- UNV-005: `install:node --service` on macOS uses the same launchd template as the verified `install:macos`, but the node-only install path itself has not been executed on a fresh Mac.
- UNV-006: The 0.3.0 MCP surface exposes 15 first-class tools including `reach_plan`, `reach_commit_plan`, and `reach_receipts`; source/type/unit/build evidence exists, but the persistent public gateway/node are still the verified 0.2.0 deployment until separately installed and smoked.
- UNV-007: GitHub Actions validation and CodeQL workflow definitions are present in the repository candidate; their first hosted runs are pending the push of this revision.

## 8. Unknown or Evidence-Stale State
- UNK-001: (resolved → VER-009/VER-010) ChatGPT workspace app deployed, linked, configured, and parity-tested.

## 9. Pending Work
- PND-001: (done, r4) ChatGPT app deployed and parity-tested.
- PND-002: (done, r4) Claude-issued DEX call verified.
- PND-003: Attach or discover an Android device and exercise a harmless ADB identity call through DEX. Continue adapter replacement only where native paths have equivalent proof.
- PND-004: Enroll a real second device and repeat the simulation matrix (`scripts/sim-two-nodes.ts` with its node ID) plus one real ChatGPT OFF/READ-ONLY/ON check.
- PND-005: Owner password is the bootstrap-generated 32-character value in `~/.dex-reach/secrets.env`; a user-chosen replacement must be ≥16 characters (gateway config enforces this) and requires a gateway restart plus re-linking any client whose refresh token has expired.
- PND-006: Remote Desktop Commander's external hosted-relay process remains separate from DEX and is not required by DEX. The npm package `@wonderwhy-er/desktop-commander` remains a DEX compatibility dependency (spawned per node with telemetry off and an isolated HOME) for `reach_list_tools`/`reach_call`; native paths cover file read/write, process run, repo info, checkpoint, and ADB. Whether to stop the unrelated external fallback remains a deployment-owner decision.
- PND-007: Install/restart the persistent primary gateway/node from 0.3.0, run the updated 15-tool public smoke, refresh client action discovery if necessary, and exercise `reach_plan`, `reach_commit_plan`, and `reach_receipts` through a real client before promoting those paths to deployed verification.
- PND-008: Observe the first pushed GitHub Actions validation and CodeQL runs; do not describe hosted CI as verified until those runs complete successfully.
## 10. Active Decisions, Defaults, and Prohibitions
- Repository source is public. Runtime access remains authenticated, explicitly enrolled, node-scoped, locally governed, and fail-closed.
- Nodes connect outbound to a relay-first gateway; direct/P2P transport is optional future work.
- Desktop Commander is a replaceable MIT compatibility adapter with isolated HOME/config state.
- No force push, destructive Git reset/clean, public unauthenticated shell, plaintext credential logging, or silent path-scope widening.

## 11. Validation and Evidence Matrix
| ID | Capability | State | Evidence / decisive check |
| --- | --- | --- | --- |
| VER-001 | Local compatibility backend | verified | Fresh official MCP SDK probe listed 26 tools |
| VER-002 | Persistent Mac services | verified | Both launchd jobs running; health reports onlineNodes=1 |
| VER-003 | Public OAuth/MCP execution | verified | `npm run smoke` PASS through Funnel HTTPS URL |
| VER-004 | Gateway recovery | verified | Deliberate gateway termination followed by node auto re-registration |
| VER-005 | Static/regression/build | verified | typecheck/test/build/audit PASS |
| VER-006 | Per-node credential rotation | verified | Live token rotation + node-only restart; gateway PID unchanged; old grace credential expired |
| VER-007 | Native executor + checkpoint | verified | Public `npm run smoke` PASS with native file/process, ADB discovery, dirty Git checkpoint |
| VER-008 | Claude MCP registration/OAuth | verified | User-scope server Connected; DEX OAuth callback completed |
| UNV-001 | Android hardware control | implemented-unverified | No ADB USB or mDNS device currently visible |
| VER-009 | ChatGPT OAuth/MCP handshake | verified | Gateway log sequence DCR/authorize/token/initialize/initialized/tools-list from openai-mcp/1.0.0 |
| VER-010 | ChatGPT real-client parity (5 tests) | verified | Live chat responses + audit.jsonl entries for fingerprint, file write, file read, process run |
| VER-011 | Claude-issued tool invocation | verified | Claude Code session called reach_list_nodes over public MCP |
| VER-012 | Node policy vs real ChatGPT | verified | OFF refusal + READ-ONLY write refusal from real ChatGPT chat; sim audit attribution |
| VER-013 | Node policy vs Claude Code | verified | Read-only sim node refused Claude write, allowed fingerprint |
| VER-014 | Two-node simulation (24 checks) | verified | `scripts/sim-two-nodes.ts` PASS against live gateway |
| VER-015 | Local kill switch / timed / per-client / audit CLI | verified | Sim-node CLI session + unit tests |
| VER-016 | Gateway restart session recovery | verified | 404 on unknown session; Claude re-initialized |
| VER-017 | READ-ONLY shell-free / compatibility fail-closed hardening | verified (source/unit) | Adversarial command and compatibility allowlist regression tests pass |
| VER-018 | Capability grants + policy assertions | verified (source/unit) | Client/capability/root/use/ceiling tests pass, one-use grants resist concurrent double-spend, and invalid policy writes fail |
| VER-019 | Exact plans + signed receipts | verified (source/unit) | One-use plan test + Ed25519 nested-metadata signature/tamper/hash-chain/content-omission test pass |
| UNV-006 | 15-tool 0.3.0 public MCP deployment | implemented-unverified | Source/build/tool registration exists; persistent deployment still 0.2.0 |
| UNV-007 | Hosted CI / CodeQL | implemented-unverified | Workflow definitions added; pushed run not yet observed |
| UNV-003 | Second physical device | implemented-unverified | Not available; simulated only |
| UNV-004 | Linux systemd install | implemented-unverified | Unit generated/tested for shape only |
| UNV-005 | macOS node-only service install | implemented-unverified | Same template as verified install:macos; not run on a fresh Mac |

## 12. Current Change Scope and Impact Radius
DEX//REACH repository plus private deployment state outside Git: gateway state, per-node credential files, user service definitions, and the existing Tailscale Funnel HTTPS reverse proxy. Existing Remote Desktop Commander remains installed as fallback while ChatGPT/Claude host parity is incomplete.

## 13. Compact Revision Log
- r8 — 0.3.0 source-security and verifiable-control candidate: removed arbitrary shell interpretation from READ-ONLY native execution, made compatibility READ-ONLY fail closed through an explicit allowlist, added root/use/time-bounded capability grants and policy assertions, exact one-use plan/commit records with checkpoint attempts and policy/client binding, local Ed25519-signed hash-chained receipts, 15-tool MCP metadata, adversarial/unit regression coverage, GitHub validation + CodeQL workflows, README/security corrections, and explicit separation between source/unit proof and the still-0.2.0 deployed public service.
- r7 — Sanitized public operational evidence by removing deployment-specific hostnames, app/chat identifiers, local usernames/paths, process details, and second-device personal names while retaining verification claims and trust invariants.
- r6 — Reconciled public-source onboarding: HTTPS clone path, no repository-access prerequisite, generic public examples, explicit separation of public code from private enrollment/runtime authority, private vulnerability-reporting policy, and preserved node-local trust invariants.
- r1 — Initialized authoritative state from the user contract and inspected machine/repository evidence.
- r2 — Implemented, installed, and validated gateway/node/OAuth/MCP path; added public HTTPS ingress and recovery proof.
- r3 — Added per-node credential enrollment/rotation, migrated and live-rotated the Mac credential, enforced scope on native operations, moved file/process primitives native, verified ADB discovery and dirty-worktree checkpoint over public MCP, and registered/authenticated Claude Code.
- r5 — Second-device trust model: node-local access policy (`src/shared/access.ts`; off/read-only/on, timed windows with deterministic expiry, per-client caps, fail-closed defaults), enforced in the node before every request; gateway forwards non-secret actor identity and displays node policy; audit records actor and never file contents; local CLI (`npm run dex`: status/enable/read-only/disable/client/audit/uninstall) working offline; `install:node` second-device installer (starts off; macOS launchd; Linux unit generated) and `enroll` default `DEX_REACH_INITIAL_ACCESS=off`; routing hardened (blank/unknown/revoked IDs fail, gateway sweep enforces CLI revocation on connected nodes, revoke bookkeeping, `forget` tombstone cleanup); default cwd confined to allowed roots; unknown MCP session → 404 for client recovery; docs/TRUST_AND_PRIVACY.md and docs/SECOND_DEVICE_QUICKSTART.md; two-node simulation and real ChatGPT/Claude cross-policy checks.
- r4 — Root cause of the "0 actions" ChatGPT app: the app existed (created 00:14Z, DCR succeeded) but no OAuth authorization was ever completed, so ChatGPT had no link and never fetched `tools/list`; creating a replacement failed with HTTP 409 (duplicate name) because the disabled app still existed. Repair: re-enabled/published the existing app, completed the owner OAuth approval, refreshed actions, set approval mode `ask_before_writes`, saved. Gateway changes: `trust proxy loopback` (fixes express-rate-limit X-Forwarded-For validation errors behind Funnel), secret-free handshake logging, empty-scope → `mcp:tools` defaulting with unsupported-scope rejection, MCP tool titles/descriptions/annotations (readOnlyHint etc.) so ChatGPT classifies reads vs writes, platform-aware node shell (`DEX_REACH_SHELL`), smoke checkpoint fixture inside an advertised allowed root, smoke gate for tool metadata. Documented second-device enrollment and ChatGPT app procedure.
