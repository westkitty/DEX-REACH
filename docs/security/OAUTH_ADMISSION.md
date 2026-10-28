# OAuth admission control

The gateway's OAuth endpoints are reachable from the public internet through Tailscale Funnel. Each one is admitted by `oauthRateLimit` in `src/gateway/oauth-server.ts`, which uses `express-rate-limit` with 60-second windows:

1. **Per client, always first.** Keyed by Express's `req.ip`, with IPv6 grouped by /56. One address is stopped by its own budget and can never spend anyone else's.
2. **Route-wide, only where the total is the risk.** One fixed key shared by every caller, applied only to owner-password guesses and persisted registrations.

| Route | Per client | Route-wide | Why this budget |
| --- | --- | --- | --- |
| Discovery (`/.well-known/...`) | 120 | none | Static metadata, fetched once per connect. |
| `POST /register` | 5 | 20 | Unauthenticated, and every registration is persisted. A shared ceiling blocks nothing ChatGPT needs, because ChatGPT uses CIMD. |
| `GET /authorize` | 30 | none | Creates a pending ticket that lasts 10 minutes. |
| `POST /dex/approve` | 10 | 30 | Checks the owner password, and a failed attempt leaves its ticket usable. The shared ceiling caps distributed guessing. At worst, new approvals wait a minute. |
| `POST /token` | 60 | none | The canary uses a few calls per six-hour cycle, ChatGPT refreshes occasionally, and a code exchange is one call. |
| `POST /revoke` | 30 | none | The canary revokes once per cycle. |

Observed live traffic on 2026-10-28 was 3 token requests in about six hours. A full connect followed by six canary cycles in one window passes in `tests/oauth-admission.test.ts`, and so does a flood from one address that leaves other clients admitted on every route.

## Why there is no shared ceiling on token, authorize, revoke or discovery

A shared ceiling lets a few addresses lock everyone out, including ChatGPT's refresh and the canary. The first version of this change checked a shared ceiling *before* the per-client one, so a single address could do this. Review caught it. Memory is bounded a different way instead: each route's per-client counts live in a `BoundedWindowStore` that holds at most `OAUTH_CLIENT_KEYS_PER_WINDOW` (10,000) distinct clients per window. A client the store has not seen, arriving once it is full, is refused for the rest of that window and never stored. Clients already counted keep working. Limiter keys never include the request path.

## Client identity

The gateway sets `trust proxy: 'loopback'`. The Funnel hop connects from loopback and appends the real peer to `X-Forwarded-For`, so `req.ip` is that appended address. Entries further left are caller-controlled and ignored. Callers on the machine itself share the `127.0.0.1` key.

The tests prove Express's derivation. They do not prove the live Funnel's header behaviour. If Funnel ever passed a caller's header through unchanged, per-client keys could be spoofed. The bounded store would still cap limiter memory at 10,000 keys per route per window, and the registration and consent ceilings would still hold. Token throughput would then rest on that store's ceiling rather than on per-client fairness.

## Responses and reset

A refused request gets `429` with `{"error":"temporarily_unavailable","error_description":"OAuth endpoint rate limit exceeded; retry later"}`, plus standard `RateLimit` and `Retry-After` headers. Request bodies, client IDs, codes and tokens are never logged by the limiter. A throttled `/token` request is also recorded in token-endpoint health (`token4xx`, `lastFailureCode: temporarily_unavailable`), so throttling shows up in `doctor`. Counters live only in gateway memory. They reset when a window ends, and also when the gateway restarts.

## Registration capacity

Dynamic registration is capped at `MAX_DYNAMIC_CLIENTS` (256) persisted clients. ChatGPT's metadata-document (CIMD) client does not count toward the cap. On 2026-10-28 the live store held 49 dynamic clients. Past the cap, `/register` answers `503 temporarily_unavailable`. Existing clients are never pruned automatically, so no working connection is cut off. Removing stale registrations is a deliberate owner action.
