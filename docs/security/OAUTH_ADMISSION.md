# OAuth admission control

The gateway's OAuth endpoints are reachable from the public internet through Tailscale Funnel. Every one of them is admitted by two `express-rate-limit` limiters (`oauthRateLimit` in `src/gateway/oauth-server.ts`), checked in order:

1. **Route-wide.** One fixed key per route, shared by every caller.
2. **Per client.** Keyed by Express's `req.ip`. IPv6 addresses are grouped by /56.

Each window is 60 seconds. Budgets are per window:

| Route | Per client | Route-wide | Why this budget |
| --- | --- | --- | --- |
| Discovery (`/.well-known/...`) | 120 | 600 | Static metadata; clients fetch it once per connect. |
| `POST /register` | 5 | 20 | Unauthenticated, and every registration is persisted. |
| `GET /authorize` | 30 | 60 | Creates a pending ticket that lasts 10 minutes. |
| `POST /dex/approve` | 10 | 30 | Checks the owner password. A failed attempt leaves its ticket usable. |
| `POST /token` | 60 | 240 | The canary uses a few calls per six-hour cycle, ChatGPT refreshes occasionally, and a code exchange is one call. |
| `POST /revoke` | 30 | 60 | The canary revokes once per cycle. |

Observed live traffic on 2026-10-28 was 3 token requests in about six hours. A full connect followed by six canary cycles in one window passes in `tests/oauth-admission.test.ts`.

## Why two tiers

The route-wide tier is checked first. A request it refuses never reaches per-client accounting, so the per-client store sees at most the route budget of distinct keys in a window. That bound holds however many addresses an attacker controls. The memory stores reset every window, and limiter keys never include the request path.

The price is availability under a distributed flood. Once the route-wide budget is spent, legitimate callers also get 429 until the window resets. This is no worse than the gateway being unreachable, and both the canary and ChatGPT retry. Unbounded memory growth, which the previous per-`ip:path` map allowed, is not an acceptable trade.

## Client identity

The gateway sets `trust proxy: 'loopback'`. The Funnel hop connects from loopback and appends the real peer to `X-Forwarded-For`, so `req.ip` is that appended address. Entries further left are caller-controlled and ignored. Callers on the machine itself share the `127.0.0.1` key.

The tests prove Express's derivation. They do not prove the live Funnel's header behaviour. If Funnel ever passed a caller's header through unchanged, per-client keys could be spoofed, but the route-wide tier would still bound both throughput and limiter state.

## Responses and reset

A refused request gets `429` with `{"error":"temporarily_unavailable","error_description":"OAuth endpoint rate limit exceeded; retry later"}`, plus standard `RateLimit` and `Retry-After` headers. Request bodies, client IDs, codes and tokens are never logged by the limiter. Counters live only in gateway memory. They reset when a window ends, and also when the gateway restarts.

## Registration capacity

Dynamic registration is capped at `MAX_DYNAMIC_CLIENTS` (256) persisted clients. ChatGPT's metadata-document (CIMD) client does not count toward the cap. On 2026-10-28 the live store held 49 dynamic clients. Past the cap, `/register` answers `503 temporarily_unavailable`. Existing clients are never pruned automatically, so no working connection is cut off. Removing stale registrations is a deliberate owner action.
