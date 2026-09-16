# DEX//REACH Protected Capability Invariants

These are release-blocking behavioral invariants, not aspirations. Each entry states what must remain true, what evidence is acceptable, and when the invariant must be rechecked.

| ID | Protected capability | Preconditions / action | Expected result | Acceptable proof | Current proof state | Recheck trigger |
| --- | --- | --- | --- | --- | --- | --- |
| DEX-INV-001 | Explicit machine selection | Any remote operation | Exact `node_id` is required; blank/unknown/offline/revoked IDs fail and never fall back | Routing regression test + live `reach_list_nodes`/targeted call | Verified | Routing, registry, MCP, enrollment changes |
| DEX-INV-002 | Node-local owner authority | Node OFF/READ-ONLY/ON, timed mode, client ceiling, grants | Node applies the latest local policy immediately before execution; a remote client cannot increase authority | Access concurrency tests + deployed policy refusal | Verified | Policy, grants, reservation, routing changes |
| DEX-INV-003 | Fail-closed policy | Policy absent/corrupt | Effective access is OFF; policy check reports invalid state | Access regression tests + `npm run dex -- policy-check` | Verified | Policy schema/persistence changes |
| DEX-INV-004 | Filesystem scope | Native/compat path request including symlink, plural/nested/camelCase path fields | Path resolves inside configured roots and outside DEX private state, or request is refused | Security/native tests + live compatibility smoke | Verified | Path parser, native FS, compatibility schema changes |
| DEX-INV-005 | Compatibility configuration stays node-owned | Remote compatibility call | Safety config, local call-history, vendor feedback/onboarding tools are not remotely advertised/invocable; URL proxy reads fail | Backend filtering tests + deployed 22-tool smoke | Implemented; deployed reproof pending final install | Backend package/version/tool-surface changes |
| DEX-INV-006 | READ-ONLY is shell-free | READ-ONLY process or compatibility request | No arbitrary shell parsing, chaining, redirection, substitution, write tool, or unknown compatibility tool executes | Security/access tests + real refusal path | Verified | Command parser/profile/tool allowlist changes |
| DEX-INV-007 | ON/full-local limits are represented honestly | Enabled shell execution | Requested cwd is root-scoped and command guards apply, but docs never claim OS filesystem sandboxing | README/SECURITY review + native tests | Verified | Shell/executor/sandbox changes |
| DEX-INV-008 | Process children do not inherit credentials | Any native or compatibility subprocess | DEX node token/owner password/env-file and obvious secret-bearing env vars are absent; known parent secret values are redacted from returned output | Native regression test + deployed `env` smoke | Implemented; deployed reproof pending final install | Child-process/backend environment changes |
| DEX-INV-009 | Remote transport protects credentials | Public/non-loopback gateway identity or node WebSocket | Public MCP identity uses HTTPS; remote node transport uses WSS; cleartext WS/HTTP allowed only for loopback development | Config regression tests | Verified | Gateway/node config changes |
| DEX-INV-010 | Exact plan executes at most once | Create then concurrently commit a consequential plan | Exactly one claimant; client/policy/request/expiry must still match; stored raw args scrub after claim/expiry | Plan concurrency/expiry tests + public plan→commit smoke | Verified | Plan storage/commit changes |
| DEX-INV-011 | Receipts are signed and linear | Concurrent node execution receipts | Each receipt signature/hash verifies and predecessor relation forms one chain without raw request/result contents | Receipt concurrency/tamper tests + public receipt smoke | Verified after repairing a reproduced stale-lock recovery TOCTOU; 5 focused lock/receipt stress runs, 3 complete post-fix regression runs, and the final golden worker passed | Receipt/key/storage changes or any recurrence |
| DEX-INV-012 | Concurrent owner/state writes do not lose authority | Competing policy, grant, revocation, credential, OAuth, or bootstrap writers | Atomic/locked update preserves latest authorized state; stale writers cannot roll it back | Access/auth/revocation/bootstrap regression tests | Verified | State persistence changes |
| DEX-INV-013 | Credentials are independent and revocable | Rotate/revoke/forget one node | Other nodes remain unaffected; revoked node cannot reconnect; clean re-enrollment is possible only after owner forget/re-enroll flow | Node-auth tests + prior live rotation/revocation proof | Verified | Registry/node-auth changes |
| DEX-INV-014 | Public source grants no runtime authority | Clone/read public repository | No gateway/node credential, policy, enrollment file, private key, or deployment secret is present or inferred as authority | Git secret/path review + architecture | Verified for inspected tree | Any commit touching config/auth/deployment artifacts |
| DEX-INV-015 | Persistent self-update survives transport replacement | Run macOS install from DEX itself | Installer returns before gateway/node replacement; one-shot helper cycles services once; node reconnects; no restart loop | Live `install:macos` status + PID stability window | Verified | macOS installer/service lifecycle changes |
| DEX-INV-016 | Dock launcher is a recovery/control surface, not an authority escalator | Click `DEX REACH.app` | New Terminal instance opens DEX control console; launch alone does not alter access mode, ceilings, grants, credentials, roots, or profile | Signed bundle/Dock URL/process/Terminal-content proof + policy comparison | Verified; final post-build reproof pending | Launcher/console/install changes |
| DEX-INV-017 | Public MCP surface is exactly the intended contract | OAuth/PKCE client lists tools | 15 first-class tools with metadata; deployed node version matches source; safe compatibility surface matches expected count | `npm run smoke` | Verified before latest hardening; final reproof pending | MCP/tool/version/auth changes |
| DEX-INV-018 | ADB availability is not faked | Deployed node runs ADB discovery | `available:true` only when `adb` actually launches; no attached device is not reported as tool unavailability | Live `reach_adb_devices` + public smoke | Verified on primary Mac | Service PATH/ADB integration changes |
| DEX-INV-019 | Simulation stays labeled simulation | Isolated second-node tests | No statement upgrades simulated process evidence into separate-hardware proof | Operational State/README review | Verified | Documentation/release claims |

## Mandatory validation subsets

### Any gateway/MCP/auth change

- DEX-INV-001, 002, 005, 009, 012, 013, 017
- `npm run typecheck`
- `npm test`
- `npm run build`
- deployed `npm run smoke`

### Any node/executor/security change

- DEX-INV-002 through 012, 017, 018
- `npm run typecheck`
- `npm test`
- `npm run build`
- deployed `npm run smoke`

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
