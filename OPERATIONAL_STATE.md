# DEX//REACH Operational State

<!-- operational-state:metadata
{"schema_version":1,"project_id":"dex-reach","project_name":"DEX//REACH","project_root":"/Users/andrew/DEX-REACH","artifact_path":"","state_revision":2,"last_updated":"2026-09-15T23:20:09Z","current_baseline":{"identity":"validated initial release baseline on main","state":"current-baseline","last_verified":"2026-09-15T23:20:09Z"},"scope_boundaries":["DEX//REACH gateway, node agent, MCP interface, local service install, project docs"],"linked_parent_state":null}
-->

## 1. Project Identity and Scope
DEX//REACH is a secure AI-native remote-computing control plane intended to replace the useful Remote Desktop Commander workflow without depending on its hosted relay.

## 2. Current Baseline
Private repository at `/Users/andrew/DEX-REACH`. macOS gateway and node are installed as user `launchd` services. Public HTTPS ingress is active at `https://macbook-air.tailafb7e8.ts.net` through Tailscale Funnel to the localhost gateway.

## 3. Artifact Contract
Provide filesystem, search/edit, terminal/process, development/Git, multi-node routing, MCP access, authentication/revocation, bounded output, auditability, ADB discovery, recovery primitives, and persistent local operation.

## 4. Active Invariants
- INV-001: Do not disable the incumbent Remote Desktop Commander before actual ChatGPT/Claude parity proof.
- INV-002: DEX//REACH owns its gateway, node protocol, routing, authorization, and audit architecture.
- INV-003: Telemetry is off in the isolated compatibility backend; credentials and secrets never enter Git or audit logs.
- INV-004: Remote operations are explicitly node-scoped and path/capability bounded.
- INV-005: Only the authenticated gateway is publicly proxied; raw shell and node sockets are not directly exposed.
## 5. Verified Working Behavior
- VER-001: Pinned Desktop Commander 0.2.50 is driven through the official MCP SDK and exposes 26 local tools.
- VER-002: Gateway and node run persistently under `launchd`; health reports one online Mac node.
- VER-003: OAuth dynamic registration, owner approval, PKCE, token exchange, stateful MCP, node routing, file roundtrip, and process execution pass through the public HTTPS endpoint.
- VER-004: Gateway restart terminates node sockets and the node automatically re-registers with the replacement gateway.
- VER-005: Strict typecheck, production build, 5 regression tests, and npm audit with 0 vulnerabilities pass.

## 6. Known Not Working
None in the verified local/public SDK path.

## 7. Implemented but Unverified
- UNV-001: Actual ADB device availability is environment-dependent; the bridge/tool path exists.
- UNV-002: `reach_checkpoint` is implemented but not exercised against a dirty non-DEX repository in this pass.

## 8. Unknown or Evidence-Stale State
- UNK-001: Actual ChatGPT and Claude client registration remains unverified because connecting those clients requires explicit user-side authorization/configuration.

## 9. Pending Work
- PND-001: Connect ChatGPT and Claude to `https://macbook-air.tailafb7e8.ts.net/mcp` and run parity calls.
- PND-002: Add per-node enrollment credentials before scaling beyond trusted personal nodes.
- PND-003: Replace the compatibility adapter incrementally only after native DEX executors match proven behavior.
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
| VER-005 | Static/regression/build | verified | typecheck PASS; 5/5 tests PASS; build PASS |
| UNK-001 | ChatGPT/Claude host UI | unknown | Explicit external-client connection still required |

## 12. Current Change Scope and Impact Radius
Greenfield DEX//REACH project, `~/.dex-reach` local state, two user LaunchAgents, and one Tailscale Funnel HTTPS reverse proxy. Existing Remote Desktop Commander remains installed and available.

## 13. Compact Revision Log
- r1 — Initialized authoritative state from the user contract and inspected machine/repository evidence.
- r2 — Implemented, installed, and validated gateway/node/OAuth/MCP path; added public HTTPS ingress and recovery proof.
