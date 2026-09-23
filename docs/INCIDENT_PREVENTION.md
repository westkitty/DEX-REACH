# DEX//REACH Incident Prevention Notes

This file records confirmed failures whose root cause and repair were demonstrated during the 0.3.1 hardening sweep. It is not a speculative risk list.

## Incident A — a DEX-hosted installer killed the request installing DEX

### Confirmed symptom

Running `npm run install:macos` through the live DEX node could drop the request while the node disappeared. The initial installer performed `launchctl bootout` inline and then intended to write/bootstrap the replacement service. Once it booted out the node, the process carrying those later steps was gone.

### Root cause

The updater and the service being replaced shared the same launchd job/process lifetime. A request cannot reliably destroy its own transport and then continue as though it were independent.

An early repair using `launchctl submit` exposed a second confirmed failure: the submitted helper could respawn after successful exit and repeatedly cycle DEX.

### Fast recurrence signature

1. `npm run install:macos` starts successfully from a remote DEX request.
2. The request drops at node replacement.
3. Gateway may recover while the node remains absent, or services repeatedly cycle.
4. A reloader/helper job is still active or respawning.

### Validated repair

- Stage **all** LaunchAgent definitions before replacing any live service.
- `plutil -lint` each staged definition.
- Return the invoking DEX request before replacement begins.
- Delegate replacement to a separate launchd-owned **one-shot** helper with `RunAtLoad` and **no `KeepAlive`**.
- Use one fixed helper label, unload the prior inactive helper before reuse, and remove its plist after completion.
- Record installer state separately from the calling request.
- Bound compatibility-backend shutdown instead of waiting indefinitely for SDK close.

The final live proof showed the install command returning exit 0, the expected brief disconnect, gateway/node reconnection on 0.3.1, a stable node PID after the restart window, and no repeating helper cycle.

### Regression/prevention controls

- `tests/audit.test.ts`: one-shot helper must have `RunAtLoad` and must not contain `KeepAlive`.
- `docs/GOLDEN_WORKER.md`: self-hosted install + reconnect is a required release path.
- `npm run install:macos` is the supported persistent update/restart path.
- Direct remote `launchctl kickstart -k` is not a substitute for self-hosted installation; by definition it can destroy the request invoking it.

### False leads to avoid

- A successful `npm run build` says nothing about service replacement lifecycle.
- A gateway returning does not prove the node returned.
- A helper process existing does not prove it is one-shot; `KeepAlive`/respawn behavior must be inspected.
- Retrying the same self-killing inline restart from DEX is not recovery.

---

## Incident B — stale-lock recovery could delete a new owner's lock

### Confirmed symptom

The receipt concurrency test intermittently failed: concurrently appended signed receipts did not always form one predecessor-linked chain. Focused runs could pass repeatedly, but repeated **full-suite** execution reproduced the failure.

### Root cause

The shared file-lock helper had a TOCTOU race in stale-lock recovery:

1. waiter B saw the primary lock already existed;
2. owner A finished and removed that lock;
3. B's recovery check observed the path missing and treated that as recoverable;
4. owner C acquired a new lock at the same path;
5. B unlinked the path it believed was stale, deleting C's new lock;
6. two writers could then enter the protected receipt mutation and fork the chain.

The defect was in the common state-lock primitive, not receipt hashing or Ed25519 signing.

### Fast recurrence signature

- a concurrency fixture fails only under heavier/full-suite scheduling;
- isolated reruns often pass;
- signed individual records can still verify, but predecessor linearity or a lost-update assertion fails;
- the affected state mutation uses the common file lock.

### Validated repair

`withFileLock` now:

- gives each acquired primary lock an ownership token and records its inode/device identity;
- never treats a merely disappearing lock path as stale;
- serializes stale-owner recovery with a separate recovery guard;
- forces normal acquirers that cross the recovery-guard race to relinquish their primary lock;
- releases a lock only if the pathname still refers to the inode that owner actually acquired;
- recovers a truly dead/stale owner without evicting a live owner just because it is slow.

### Regression/prevention controls

- `tests/state-io.test.ts`: starts with a deliberately stale dead-owner lock and launches 40 concurrent claimants; maximum simultaneous critical-section occupancy must remain exactly one.
- `tests/receipts-plans.test.ts`: concurrent receipts must form one verified linear chain.
- Post-fix proof: five focused lock/receipt stress runs, three complete regression runs, and the deployed golden-worker run passed.
- Any future change to `withFileLock`, policy/grant reservations, plans, receipts, node auth, revocations, bootstrap, or OAuth persistence must rerun the concurrency subset and complete suite.

### False leads to avoid

- Do not rewrite receipt hashing/signature code merely because the chain assertion fails.
- Do not downgrade a full-suite-only concurrency failure to “flaky” after a few isolated green runs.
- Do not make lock staleness time-based for a live PID; a slow owner is still the owner.
- Do not unlink a lock pathname after observing an earlier generation without proving the current pathname still belongs to that generation.


---

## Incident C — ChatGPT looked disconnected while the Mac gateway and node were healthy

### Confirmed symptom

The primary Mac reported a healthy gateway, one online node, valid owner policy, and successful MCP initialization/tool calls. The ChatGPT connector later stopped reaching DEX reliably. Gateway logs showed repeated `POST /token 500` responses from the OpenAI OAuth connector. After the refresh repair, the next real ChatGPT attempt exposed a separate public-Origin rejection even though the loopback service remained healthy.

This class of incident is dangerous operationally because it looks like one recurring “DEX is down” problem while the actual failures can occur at several independent layers: client registration, OAuth discovery, token refresh, Origin validation, public ingress, MCP session state, or node routing.

### Confirmed causes repaired

1. **Refresh-token lifecycle incompatibility.** A single-use refresh credential could be invalidated by one successful refresh while another ChatGPT worker still held the prior credential. Expected invalid grants were also surfaced through the legacy helper as opaque token-endpoint failures.
2. **Refresh capability discovery mismatch.** DEX issued refresh credentials but did not originally advertise the OAuth session-longevity scope clients use to request durable access.
3. **Public Origin drift.** Host validation admitted the configured public hostname while Origin validation still used the SDK’s localhost-oriented default, so the same configured endpoint could pass one boundary and fail the other.
4. **Frozen authorization-server dependency.** DEX’s OAuth server routes depended on `@modelcontextprotocol/server-legacy`, explicitly a migration-only frozen package. Leaving the long-lived trust boundary there would make future protocol/client changes harder to absorb safely.

### Hardened prevention controls

- DEX owns its OAuth authorization-server routes directly in `src/gateway/oauth-server.ts` instead of using the frozen `server-legacy` authorization-server helpers.
- Production access-token and refresh-token lifetimes remain one hour and thirty days by default, but tests can inject tiny lifetimes without changing production configuration.
- The HTTP regression suite performs a real authorization-code + S256 PKCE flow, waits for the access token to expire, then performs repeated/concurrent refresh requests and verifies the refreshed access tokens. An invalid refresh credential must return OAuth `invalid_grant` as a 4xx response, never a generic 500.
- Authorization-server metadata advertises `offline_access`, S256 PKCE, RFC 9207 issuer responses, Dynamic Client Registration compatibility, and CIMD support.
- ChatGPT CIMD is restricted to the exact `chatgpt.com` metadata-document namespace. Arbitrary client metadata URLs are not fetched.
- DCR remains available as a compatibility fallback. CIMD does not widen DEX machine authority: `mcp:tools` is still required by the protected resource.
- OAuth runtime diagnostics persist **counts and status classes only**: token 2xx/4xx/5xx totals, last success/failure timestamps, last OAuth error code, and active/expired credential counts. Token values, hashes, client IDs, owner credentials, and redirect URIs are not exposed by diagnostics.
- `npm run dex -- doctor --share` includes the safe OAuth summary and canary outcome while withholding the public endpoint and all credential material.
- `npm run oauth:health` exits non-zero if the deployed gateway has recorded any token-endpoint 5xx since startup. `verify:golden` includes this check.
- The macOS installer provisions `com.stinkyweasel.dex-reach.oauth-canary`, a non-persistent `RunAtLoad` + six-hour `StartInterval` LaunchAgent. It traverses the configured public HTTPS OAuth/MCP path, persists its own 0600 OAuth state outside Git, and performs only `reach_list_nodes` plus an explicit-node `reach_fingerprint`.
- The canary persists the SDK discovery state and PKCE verifier with its credentials so redirect/restart boundaries remain issuer-bound rather than silently re-discovered.
- Reauthorization is classified as **recovery**, not repair evidence. If reconnecting ChatGPT becomes necessary repeatedly, open an OAuth incident and inspect `doctor --share`, `oauth:health`, canary status, and public gateway logs instead of normalizing the ritual.

### Fast recurrence signatures

- **Gateway/node healthy + `/token 5xx`:** authorization-server defect or unexpected internal token failure. This is release-blocking.
- **Gateway/node healthy + `invalid_grant` 4xx:** expired/revoked/mismatched client credential; investigate client state without treating the server as crashed.
- **Loopback healthy + public canary failed:** public ingress, OAuth discovery/client identity, Origin/Host policy, or public MCP path.
- **Public canary succeeds + ChatGPT fails:** likely ChatGPT-specific stored client/token/session state or client-side action cache.
- **Canary refresh credential present, then a later six-hour run succeeds after access-token expiry:** deployed public refresh lifecycle has been observed without user reauthorization.

### False leads to avoid

- Do not restart launchd merely because ChatGPT cannot call a tool; prove whether the public OAuth path or node is failing first.
- Do not treat `/healthz` as an OAuth proof. It intentionally requires no authentication.
- Do not treat a fresh reauthorization as proof that refresh works.
- Do not widen allowed Origins, roots, tool scopes, node policy, or client ceilings to make authentication pass.
- Do not put OAuth state or canary credential files in Git, logs, screenshots, or support bundles.
