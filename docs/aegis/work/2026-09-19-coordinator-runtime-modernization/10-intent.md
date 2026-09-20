# Intent

Outcome: install current DEX//REACH runtime and deliver a single-writer local
coordinator with resource-aware admission, safe telemetry, browser-visible queue
context, and a credential-free workspace worker.

Parent: `docs/aegis/plans/2026-09-19-coordinator-runtime-modernization.md`.

Scope: coordinator daemon/socket, bundle admission, event/metric projection,
restricted worker, existing sixteen-action MCP compatibility, persistent macOS
service deployment and browser connector validation.

Non-goals: changing the sixteen tool names/count, granting new authority,
persisting secrets or arbitrary command text, or claiming access to private
model reasoning.

Baseline: `df080771996a6cdb953349b3374b59a9e6fe24fe` on
`claude/work-coordinator-cpcug3`, equal to upstream at start. Gateway and node
install completed through `npm run install:macos`; the launchd helper recorded
successful bootout/bootstrap/kickstart for both services and local `/healthz`
responded.

Success evidence: focused new regression tests, repository verification gate,
launchd service status, authenticated live MCP sixteen-action list, and an
observed connector refresh or an explicit user-only consent boundary.

Stop states: a secret/authority boundary breach, incompatible MCP contract,
failed persistent-service replacement, or a browser consent action that only
the owner can complete.
