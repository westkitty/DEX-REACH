# DEX//REACH Operational State

<!-- operational-state:metadata
{"schema_version":1,"project_id":"dex-reach","project_name":"DEX//REACH","project_root":"/Users/andrew/DEX-REACH","artifact_path":"","state_revision":4,"last_updated":"2026-09-16T01:50:00Z","current_baseline":{"identity":"DEX//REACH 0.2.0 ChatGPT-parity-verified baseline on main","state":"current-baseline","last_verified":"2026-09-16T01:50:00Z"},"scope_boundaries":["DEX//REACH gateway, node agent, MCP interface, local service install, project docs"],"linked_parent_state":null}
-->

## 1. Project Identity and Scope
DEX//REACH is a secure AI-native remote-computing control plane intended to replace the useful Remote Desktop Commander workflow without depending on its hosted relay.

## 2. Current Baseline
Private repository at `/Users/andrew/DEX-REACH`. macOS gateway and node are installed as user `launchd` services. Public HTTPS ingress is active at `https://macbook-air.tailafb7e8.ts.net` through Tailscale Funnel. The Mac node uses its own mode-0600 credential file and gateway authentication is keyed by node ID with persisted token hashes. The ChatGPT Business workspace app `DEX//REACH` (`asdk_app_6aa9df5974b081918e1b66f8d1aad2d2`) is enabled, OAuth-linked, exposes all 12 MCP actions, and has passed real-client parity tests.

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
- VER-010: Real ChatGPT parity (new normal chat, app invoked via `@DEX//REACH`, chat `6aa9f22d-f058-83ea-b723-0a1db1ca093b`): node discovery returned `macbook-air.local — online`; fingerprint returned this Mac's hostname/user/repo/branch/remote/Node version; file write produced `/tmp/dex-reach-gpt-test.txt` with exactly `GPT DEX REACH parity test` (25 bytes, audit `dex.file.write` by ChatGPT client `58e0d75f…`); file read echoed identical contents (audit `dex.file.read`); `pwd` returned `/Users/andrew/DEX-REACH`, exit 0 (audit `dex.process.run`). Writes prompted ChatGPT's Allow/Deny approval as configured (`ask_before_writes`); reads ran without prompts.
- VER-011: Claude-issued DEX tool invocation verified: a Claude Code session called `reach_list_nodes` through the public MCP endpoint and received the live node record.

## 6. Known Not Working
None in the verified local/public SDK path or the ChatGPT real-client path.

## 7. Implemented but Unverified
- UNV-001: ADB discovery is verified through public MCP, but no Android hardware is currently attached or discoverable by mDNS, so device-control behavior remains unverified.
- UNV-002: (resolved → VER-011) Claude-issued invocation verified from a Claude Code session.
- UNV-003: Second-device enrollment is implemented (per-node `enroll`, env transfer, `DEX_REACH_ENV_FILE` node start, outbound WebSocket, explicit `node_id` routing with no fallback) and documented in README, but no second physical device has been enrolled yet. Linux/Windows persistent-service adapters do not exist; `dex.process.run` refuses win32.

## 8. Unknown or Evidence-Stale State
- UNK-001: (resolved → VER-009/VER-010) ChatGPT workspace app deployed, linked, configured, and parity-tested.

## 9. Pending Work
- PND-001: (done, r4) ChatGPT app deployed and parity-tested.
- PND-002: (done, r4) Claude-issued DEX call verified.
- PND-003: Attach or discover an Android device and exercise a harmless ADB identity call through DEX. Continue adapter replacement only where native paths have equivalent proof.
- PND-004: Enroll a real second device (e.g. Bryan's machine) and verify explicit cross-node routing with two nodes online simultaneously.
- PND-005: Owner password is the bootstrap-generated 32-character value in `~/.dex-reach/secrets.env`; a user-chosen replacement must be ≥16 characters (gateway config enforces this) and requires a gateway restart plus re-linking any client whose refresh token has expired.
- PND-006: Retire Remote Desktop Commander only after PND-004 or an explicit decision that single-node parity is sufficient; RDC remains installed and untouched.
## 10. Active Decisions, Defaults, and Prohibitions
- Repository is private by default.
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
| UNV-003 | Second-device enrollment | implemented-unverified | Workflow documented; no second device enrolled yet |

## 12. Current Change Scope and Impact Radius
DEX//REACH repository, `~/.dex-reach` gateway state, per-node credential files, two user LaunchAgents, and the existing Tailscale Funnel HTTPS reverse proxy. Existing Remote Desktop Commander remains installed as fallback while ChatGPT/Claude host parity is incomplete.

## 13. Compact Revision Log
- r1 — Initialized authoritative state from the user contract and inspected machine/repository evidence.
- r2 — Implemented, installed, and validated gateway/node/OAuth/MCP path; added public HTTPS ingress and recovery proof.
- r3 — Added per-node credential enrollment/rotation, migrated and live-rotated the Mac credential, enforced scope on native operations, moved file/process primitives native, verified ADB discovery and dirty-worktree checkpoint over public MCP, and registered/authenticated Claude Code.
- r4 — Root cause of the "0 actions" ChatGPT app: the app existed (created 00:14Z, DCR succeeded) but no OAuth authorization was ever completed, so ChatGPT had no link and never fetched `tools/list`; creating a replacement failed with HTTP 409 (duplicate name) because the disabled app still existed. Repair: re-enabled/published the existing app, completed the owner OAuth approval, refreshed actions, set approval mode `ask_before_writes`, saved. Gateway changes: `trust proxy loopback` (fixes express-rate-limit X-Forwarded-For validation errors behind Funnel), secret-free handshake logging, empty-scope → `mcp:tools` defaulting with unsupported-scope rejection, MCP tool titles/descriptions/annotations (readOnlyHint etc.) so ChatGPT classifies reads vs writes, platform-aware node shell (`DEX_REACH_SHELL`), smoke checkpoint fixture inside an advertised allowed root, smoke gate for tool metadata. Documented second-device enrollment and ChatGPT app procedure.
