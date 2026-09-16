# DEX//REACH Operational State

<!-- operational-state:metadata
{"schema_version":1,"project_id":"dex-reach","project_name":"DEX//REACH","project_root":".","artifact_path":"","state_revision":12,"last_updated":"2026-09-16T20:50:30Z","current_baseline":{"identity":"DEX//REACH 0.3.1 hardened golden-worker baseline on main","state":"verified-local-and-public-runtime","last_verified":"2026-09-16T20:50:30Z"},"scope_boundaries":["DEX//REACH gateway, node agent, MCP interface, local service install, Dock control terminal, project docs"],"linked_parent_state":null}
-->

## 1. Project Identity and Scope

DEX//REACH is a secure AI-native remote-computing control plane. It provides useful AI access while preserving device-owner authority, explicit machine selection, bounded operations, revocability, auditability, and fail-closed behavior.

Canonical public repository: `https://github.com/westkitty/DEX-REACH`.

## 2. Current Baseline

The primary macOS deployment is running DEX//REACH **0.3.1** as persistent user `launchd` gateway/node services. The node reports `full-local`, the configured owner roots, and 0.3.1 agent identity. Public OAuth/PKCE MCP smoke passes through the deployed HTTPS gateway.

Current public server surface:

- **15 first-class DEX MCP actions**;
- **22 remotely exposed compatibility tools**;
- the pinned compatibility dependency still has **26 raw local tools internally**, but safety-configuration mutation, local compatibility call history, vendor feedback, and vendor onboarding/prompt tools are withheld from remote clients;
- compatibility URL-fetch mode is blocked;
- native child processes and the isolated compatibility backend do not inherit DEX credential variables or obvious secret-bearing environment variables.

`npm run verify:golden` passes on the deployed 0.3.1 build: typecheck, **48/48 regression tests**, production build, production dependency audit with **0 vulnerabilities**, raw 26-tool compatibility probe, and live public smoke covering OAuth, 15 DEX tools, the exact 22-tool safe compatibility surface, blocked configuration/URL-proxy paths, ADB executable availability, native file/process execution, sanitized child environment, exact plan→commit, signed receipts, and checkpoint creation.

The primary macOS installer is self-host safe: it stages and validates service definitions, returns the invoking DEX request, then a separate no-`KeepAlive` one-shot LaunchAgent replaces gateway/node. The expected brief disconnect is followed by node re-registration; repeated restart loops are not accepted as success.

The Dock launcher is installed as a signed local shell-app bundle with a custom icon and exact Dock entry. A click opens a **new Terminal instance** running the DEX control console. Final proof on the 0.3.1 build showed the node PID unchanged across launcher invocation and the same access mode, profile, and per-client ceilings before and after launch.

This record describes the verified 0.3.1 source/runtime baseline but intentionally does not encode the hash or publication status of the Git commit that contains it. Git itself is authoritative for the containing commit, push state, and hosted checks; a commit cannot truthfully record the result of CI that only runs after that same commit is pushed.

## 3. Artifact Contract

Provide explicit-node remote access for filesystem, search/edit, process/terminal, Git/development, ADB discovery, multi-node routing, MCP/OAuth, local policy, authentication/revocation, capability grants, exact-action planning, signed receipts, bounded results, reversible checkpoints, persistent local operation, owner-visible recovery, and public-source documentation without granting public runtime authority.

## 4. Active Invariants

The detailed proof obligations live in [`docs/INVARIANTS.md`](docs/INVARIANTS.md). Release-blocking invariants include:

- **INV-001 — Node final authority:** OFF / READ-ONLY / ON, timed windows, per-client ceilings, and grants are enforced on the node immediately before execution.
- **INV-002 — Explicit routing:** every remote operation names a `node_id`; blank, unknown, offline, disabled, or revoked nodes fail with no fallback.
- **INV-003 — Fail closed:** missing/corrupt policy means OFF; a newly enrolled node starts OFF.
- **INV-004 — Scope:** typed/native/compatibility paths must remain within canonicalized allowed roots and outside DEX private state; symlink, plural/nested, and camelCase path fields are covered.
- **INV-005 — Compatibility safety ownership:** remote clients cannot change compatibility safety configuration, recover local call history, invoke vendor-only surfaces, or use the node as a URL proxy.
- **INV-006 — READ-ONLY is shell-free:** no arbitrary shell interpretation or unknown compatibility execution.
- **INV-007 — ON shell honesty:** ON/full-local shell is high authority and is not represented as an OS filesystem sandbox.
- **INV-008 — Secret boundary:** credential-bearing environment variables are stripped from child processes; known parent secret values are redacted from returned process output; secrets/private state remain outside Git and public output.
- **INV-009 — Transport:** non-loopback public MCP identity uses HTTPS; remote node WebSocket transport uses WSS.
- **INV-010 — Exact plans:** one exact plan has at most one claimant and binds node/client/request/policy/expiry; raw args are scrubbed after claim/expiry.
- **INV-011 — Signed receipts:** node receipts verify and form one predecessor-linked chain without raw request/result content.
- **INV-012 — Concurrent state safety:** policy/grant/plan/receipt/auth/revocation/bootstrap/OAuth mutations use atomic or locked transitions; stale writers do not roll back newer authority.
- **INV-013 — Credential independence:** node credentials rotate/revoke independently.
- **INV-014 — Public source ≠ authority:** cloning the repository provides no runtime credential, enrollment, or node authority.
- **INV-015 — Self-update survival:** persistent installation can replace the running gateway/node without depending on the request transport it is replacing.
- **INV-016 — Launcher non-escalation:** opening/recovering through the Dock launcher does not silently change policy, ceilings, grants, credentials, roots, or profile.
- **INV-017 — Evidence honesty:** simulation is never described as separate physical-hardware verification.

## 5. Verified Working Behavior

- **VER-001 — Persistent primary Mac services:** gateway/node run under launchd and the node re-registers after service replacement.
- **VER-002 — Public OAuth/MCP path:** dynamic registration, owner approval, PKCE, token exchange, initialization, tool listing, routing, and live execution pass through the deployed HTTPS gateway.
- **VER-003 — 15-tool DEX surface:** the deployed smoke sees all 15 first-class actions with expected metadata.
- **VER-004 — Safe compatibility surface:** raw pinned backend probe reports 26 tools; the deployed node exposes exactly 22 remotely. `set_config_value` is not remotely callable, and compatibility URL reads are refused.
- **VER-005 — Compatibility safety configuration:** isolated backend telemetry is disabled and configured allowed roots are verified at startup.
- **VER-006 — Native scope/security:** file/process paths, symlink escapes, plural/nested/camelCase compatibility paths, private-state targeting, destructive command classes, and READ-ONLY shell composition are regression-covered.
- **VER-007 — Child environment sanitization:** native and compatibility child environments exclude DEX credential variables/obvious secret-bearing variables; public smoke verifies no credential-bearing variable appears in native `env` output.
- **VER-008 — Policy concurrency:** stale owner-policy writers cannot overwrite newer local decisions; final reservations honor latest policy and atomically consume use-bounded grants.
- **VER-009 — Exact plans:** expiration, policy/client/request binding, single-claim concurrency, argument scrubbing, and deployed plan→commit execution pass.
- **VER-010 — Signed receipts:** signature/tamper/content-omission/chain tests pass; deployed receipts show committed work. A reproduced stale-lock TOCTOU that could fork concurrent chains was repaired; post-fix proof includes five focused lock/receipt stress runs, three complete regression runs, and the final golden worker.
- **VER-011 — Shared state locking:** stale-lock recovery uses ownership/inode identity plus a serialized recovery guard; a 40-contender stale-lock fixture never enters the critical section concurrently.
- **VER-012 — Node authentication/revocation:** concurrent credential writers preserve independent nodes; revocation tombstone mutations are locked/atomic; prior live rotation/revocation proof left unrelated nodes working.
- **VER-013 — Bootstrap concurrency:** two concurrent first-boot processes produce one coherent credential set; exactly one creates state and the other preserves it.
- **VER-014 — OAuth hardening:** approval HTML escapes untrusted dynamic client names; dynamic registration always assigns client identity server-side; OAuth persistence is serialized/atomic.
- **VER-015 — Transport configuration:** non-loopback HTTP public identity and non-loopback cleartext node WebSocket configuration are rejected by tests.
- **VER-016 — ADB executable:** deployed DEX reports `available:true`; no Android device is currently attached, so hardware control is not claimed.
- **VER-017 — Self-hosted macOS install:** `npm run install:macos` invoked through DEX returns before service replacement, node reconnects on 0.3.1, and the helper does not enter a restart loop.
- **VER-018 — Dock control terminal:** final bundle signature verifies, exact Dock tile is present, clicking opens a new Terminal instance showing DEX status/kill-switch/timed-mode/audit/receipt/grant controls, and launcher invocation preserves node PID and owner authority state.
- **VER-019 — Local quality gate:** `npm run verify` passes with 48/48 tests, build success, production audit 0 vulnerabilities, and raw compatibility probe.
- **VER-020 — Deployed golden worker:** `npm run verify:golden` passes on the installed 0.3.1 runtime with the complete smoke evidence listed in the baseline above.
- **VER-021 — Prior hosted workflows:** GitHub validation and CodeQL completed successfully for prior commit `0084650`; this proves the workflows themselves execute, not yet that the current unpushed 0.3.1 candidate is green remotely.
- **VER-022 — Multi-node policy simulation:** the isolated second-node simulation previously verified explicit routing/no-fallback, OFF/READ-ONLY/ON, roots, client ceilings, audit attribution, rotation/revocation, and primary-node isolation through the public MCP path.
- **VER-023 — Real-client historical proof:** ChatGPT and Claude previously completed OAuth/PKCE and live DEX calls/policy refusals against the deployed project. Those historical client proofs remain valid for the tested behavior; the current 15-action server surface still needs client-side action-cache refresh proof if the ChatGPT UI is expected to expose the three newer actions immediately.

## 6. Known Not Working

No unresolved confirmed primary-Mac/runtime bug remains in the inspected 0.3.1 scope after the current repair/resweep cycle.

Directly issuing `launchctl kickstart -k` **from the DEX request being killed** is intentionally not a supported self-update mechanism: destroying a transport can destroy its own response. The supported path is `npm run install:macos`, which delegates replacement to the one-shot helper. This is a lifecycle constraint, not an invitation to retry the self-killing path.

## 7. Implemented but Unverified

- **UNV-001 — Android hardware control:** ADB executable/discovery is verified; no USB/network Android device is currently attached, so real device-control behavior is unverified.
- **UNV-002 — Second physical device:** no independent second machine has completed the full enrollment/policy matrix. Multi-node evidence is simulation on the primary Mac.
- **UNV-003 — Linux service runtime:** systemd user-unit generation is implemented/shape-tested but has not run on a real Linux host.
- **UNV-004 — macOS node-only fresh-machine install:** the node-only installer uses the same staged one-shot replacement design but has not been exercised on a fresh second Mac.
- **UNV-006 — Current ChatGPT client action refresh:** the public MCP server proves 15 actions, but the currently connected ChatGPT app/client cache has not been independently shown exposing the three newer plan/commit/receipt actions in its UI after this deployment.

## 8. Unknown or Evidence-Stale State

None that blocks the primary-Mac 0.3.1 release candidate. External client caches and untested hardware/platform paths remain explicitly separated above.

## 9. Pending Work

- **PND-001:** refresh/relink ChatGPT client action discovery if direct UI access to plan/commit/receipts is required.
- **PND-002:** attach an Android device and perform a harmless hardware identity operation through DEX.
- **PND-003:** enroll a real second device and repeat explicit-node routing plus OFF/READ-ONLY/ON checks.
- **PND-004:** run the Linux systemd path on a real Linux host before claiming Linux runtime verification.
- **PND-005:** continue replacing compatibility primitives only when equivalent native behavior has equal or stronger proof.

## 10. Active Decisions, Defaults, and Prohibitions

- Repository source is public. Runtime access remains authenticated, explicitly enrolled, node-scoped, locally governed, and fail-closed.
- Nodes connect outbound; only the authenticated gateway may be intentionally public. No raw node listener/shell is exposed.
- Desktop Commander is a pinned replaceable local compatibility adapter with isolated HOME/config state; its hosted relay/app is not required by DEX.
- ON/full-local arbitrary shell is not advertised as OS-level filesystem isolation.
- No force push, destructive Git reset/clean, plaintext credential logging, invented credentials, secret publication, silent path/root/profile/trust widening, or simulation-as-hardware claims.
- `docs/INVARIANTS.md`, `docs/GOLDEN_WORKER.md`, and `docs/INCIDENT_PREVENTION.md` are durable release/repair references; README remains the human-facing overview.

## 11. Validation and Evidence Matrix

| Capability | State | Decisive current evidence |
| --- | --- | --- |
| Source/type/regression/build | verified | `npm run verify`: typecheck, 48/48 tests, build, production audit 0 vulnerabilities |
| Raw compatibility dependency | verified | probe lists 26 pinned local backend tools |
| Remote compatibility surface | verified | live node reports 22; public smoke enforces exact expected set |
| Public MCP/OAuth | verified | live `npm run smoke`: OAuth/PKCE + 15 actions |
| Owner policy/fail closed | verified | policy/grant/concurrency tests + deployed owner CLI |
| Native/compat path guard | verified | symlink/plural/nested/camelCase/private-state regression tests + live refusals |
| Process secret environment | verified | native regression + deployed public `env` smoke |
| Exact plan/commit | verified | concurrency/expiry/scrub tests + deployed plan→commit smoke |
| Signed receipt chain | verified | tamper/chain/concurrency tests + post-TOCTOU stress + deployed receipt smoke |
| Persistent macOS self-update | verified | self-hosted install returned, expected reconnect, 0.3.1/22-tool node returned |
| Dock Terminal launcher | verified | signed bundle, exact Dock URL, new Terminal window, live DEX menu, unchanged PID/policy/profile |
| ADB executable | verified | live `available:true`; no device attached |
| Containing Git commit CI/CodeQL | external-by-construction | inspect GitHub checks for the commit containing this state record; do not infer hosted CI from this file alone |
| Second physical device | unverified | simulated second-node proof only |
| Linux runtime | unverified | generated/shape-tested only |
| Android hardware operation | unverified | no device attached |

## 12. Current Change Scope and Impact Radius

The 0.3.1 candidate changes gateway/node authorization and state persistence, compatibility exposure, execution-plan/receipt integrity, macOS service lifecycle, node-only installer lifecycle, local control tooling, public smoke, security/config validation, Dock control-terminal packaging, tests, README/security docs, invariant/golden-worker/incident-prevention docs, and this operational record. Private deployment state remains outside Git.

## 13. Compact Revision Log

- **r12** — Exhaustive 0.3.1 hardening/golden-worker sweep. Closed symlink/plural/camelCase scope bypasses, policy stale-write rollback, plan double-claim, receipt-chain races, node-auth/revocation/bootstrap/OAuth persistence races, OAuth client-ID injection, public HTTP/remote WS transport gaps, compatibility safety-config/history/vendor/URL-proxy exposure, child-process credential-environment leakage, launchd Homebrew PATH/ADB false-positive behavior, self-hosted installer self-termination/respawning-helper failures, and Dock launcher Terminal/TCC mismatch. Reproduced and repaired a second receipt fork caused by stale-lock recovery deleting a newer owner's lock. Final local/deployed proof: 48/48 tests, three complete post-lock regression passes, five focused lock/receipt stress passes, build, 0-vulnerability production audit, 26-tool raw backend probe, 15-tool public MCP, exact 22-tool remote compatibility surface, ADB available, plan→commit, signed receipts, checkpoint, and signed Dock app opening a new Terminal without changing node PID or authority. Publication/hosted-check state is intentionally read from Git/GitHub rather than self-asserted inside the commit being checked.
- **r11** — Historical Dock persistence repair: exact Dock URL verification replaced substring detection; launcher/icon/signature/pin were verified. Superseded by r12's shell-app Terminal control launcher.
- **r10** — Historical Dock detection correction: restricted detection to `persistent-apps` and reverified the pinned app path.
- **r9** — Introduced the primary-Mac Dock launcher and documented the then-observed forced-restart teardown problem. Superseded in r12 by bounded backend close and the self-host-safe one-shot installer lifecycle.
- **r8** — Added 0.3.0 READ-ONLY fail-closed hardening, capability grants, policy assertions, exact plan/commit, signed receipts, 15-tool MCP metadata, CI/CodeQL workflows, and adversarial tests; deployment was still on the older public surface at that time.
- **r7** — Sanitized public operational evidence and separated deployment-specific/private identifiers from public repository documentation.
- **r6** — Reconciled public-source onboarding and added private vulnerability-reporting guidance without weakening enrollment/runtime authority.
- **r5** — Added node-local access policy, second-device enrollment/install flow, explicit routing/no fallback, actor-aware audit, local control CLI, fail-closed policy, and two-node simulation/real-client policy checks.
- **r4** — Repaired ChatGPT OAuth/app action discovery, added MCP metadata/classification, proxy handling, checkpoint smoke fixture, and client handshake evidence.
- **r3** — Added per-node credential migration/rotation, native file/process/repo/checkpoint/ADB paths, and Claude registration/authentication.
- **r2** — Implemented and validated the initial persistent gateway/node/OAuth/MCP path plus public HTTPS ingress and recovery proof.
- **r1** — Initialized the authoritative operational record from repository/runtime evidence.
