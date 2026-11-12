# DEX//PANIC — Project Bible

## Product purpose
A local, independently operable macOS recovery control when DEX//REACH or a connected AI client fails. The owner must be able to distinguish observation, policy authority, admission, process liveness and unknown task effects without relying on the failing gateway.

## Immutable design obligations
- The node's existing owner CLI is the only source of DEX policy mutation. No direct editing of node policy files, no new remote listener or bypass of current policy.
- Only exact allowlisted launchd service labels are actionable. No indiscriminate kill-all, sudo, credential resets, force cleanup or broad machine reset.
- Start requires a fresh positive stopped observation; restarts of running services require explicit owner confirmation and a fresh positive running observation. Missing, stale or unreadable states refuse.
- A timeout is an ambiguous outcome, not proof execution stopped. Never automatically replay uncertain mutations or claim task reconciliation from a service restart.
- OFF is reported as verified only after a successful separate status readback confirming the exact owner-local DISABLED mode.
- Service liveness, admission capacity, node authorization, and task outcome are distinct states. A healthy-looking daemon list is not overall health.
- No unexpected installation, login item, public network egress, change to Hermes/Ollama, or canonical DEX repositories.
- Preserve the first working build and prior source. Read-only inspection works when the control gateway is unavailable.
- Quiet by default: bounded probes, no animations or notifications required to understand the interface, readable without color alone.

## History
- 2026-11-10: v0.1 initial local menu-bar prototype, guarded launchctl controls and policy-OFF CLI. 9 tests passed on Linux and Big Mac; MacBook runtime never verified.
- 2026-11-12: v0.2 uplift candidate. Distinctive Recovery Deck adds four evidence layers and flight-recorder timeline; liveness inventory and fresh-probe guards repaired; separate OFF readback and admission parser added. Test and release proof recorded in `OPERATIONAL_STATE.md`. No MacBook installation inferred.

- 2026-11-12: v0.2.1 indicator lock: white = three required daemons positively `running` through complete, fresh launchctl inventory; red + exclamation = `degraded` or `unknown`. The icon MUST NOT be called proof of coordinator admission, owner authority, task success or connection health. Render the shield as non-template to avoid menu-bar tinting; retain text status/VoiceOver. A visual test must not require stopping real DEX services; safe manual acceptance only; service-failure simulation needs a separately scoped, owner-approved window. v0.2.0 remains a preserved rollback.

- 2026-11-12: Diagnostic export must be explicitly user-initiated and **clipboard-only**, bounded and allowlisted; prohibit raw CLI stdout, passwords/tokens, machine-specific paths and arbitrary incident values. Unknown service states are observation failures until corroborated. Explain safe next steps before suggesting actions; never auto-disable, restart, elevate or replay work to clear a status. Last capacity/owner readouts are stale until re-inspected.

- 2026-11-12: Competing-work inspection is manual read-only only. View process executable basename, CPU, RSS and cautious class, never argv, env, credentials or private path. Keep Big Mac explicitly targeted, SSH-host verified and visually separated from MacBook; fail closed on unavailable remote. Do not correlate shortlist rows one-to-one with DEX coordinator uncoordinated-heavy count; no kill/suspend/restart controls in this view and no background scan. Preserve verified v0.2.2 rollback.

- 2026-11-12: PANIC 0.3.0 delivers C01–C05 as one MacBook-only menu-bar release. Big Mac MUST remain information-only (no second menu icon, app login item or service). Source/read-only CLI projections originate from fixed explicit host identity; remote SSH must verify Big Mac before returning data. Unknown task effects stay unknown, red shield retains conservative truth, and emergency control remains separate from diagnostic inspection. Preserve v0.2.3 rollback.
