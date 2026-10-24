# Production dependency audit exceptions

**These are owner-approved exceptions, not fixes.** The vulnerable code is still installed and still reachable as described below.

## The gate

`npm run audit:prod` (`scripts/audit-gate.ts`) runs `npm audit --omit=dev --json`. It is used by `npm run verify`, by the CI "Production dependency audit" step and by `scripts/release-provenance.ts`. It fails on any high or critical advisory in the production tree unless that finding matches an entry in [`security/audit-exceptions.json`](../../security/audit-exceptions.json) exactly. Moderate and low advisories are reported but do not block, the same as the previous `--audit-level=high` gate.

An entry matches only if all of these match:

- the advisory id (GHSA);
- the vulnerable package;
- its exact `node_modules/...` lockfile path.

The same advisory at any other path fails. So does any package npm reports as affected through the excepted node, unless it is listed in the entry's `dependents`.

The gate also fails, so an exception cannot outlive what it was approved for, when:

- **the entry matches no current finding** (the dependency was upgraded, fixed or removed). Delete the entry.
- **the lockfile version at the path differs from `installedVersion`.** Re-review it.
- **a listed dependent is no longer reported.** Update or delete the entry.
- **today is after `expiresOn`.** Re-review with the owner, or remove the dependency.
- **the report is unusable, or its counts are inconsistent.** It fails closed.

There is no `--audit-level` downgrade and no blanket ignore. Adding, extending or widening an entry needs an explicit owner decision recorded with its date.

## Current exceptions

| Advisory | Package @ path | Approved | Expires | Retire by |
| --- | --- | --- | --- | --- |
| GHSA-mrhx-c7xc-m3w5 (high): zod `<4.6.6` can exhaust memory while validating oversized constrained collections | `zod@3.25.76` at `node_modules/@wonderwhy-er/desktop-commander/node_modules/zod`; dependent `node_modules/@wonderwhy-er/desktop-commander` | Owner, 2026-10-24 10:38 AM ET, for 0.4.0 | 2027-01-24 | Native replacement of the desktop-commander compatibility adapter (the next planned project) |

### Why GHSA-mrhx-c7xc-m3w5 can't be fixed today

- No zod 3.x release fixes it, and 3.25.76 is the latest 3.x.
- desktop-commander's latest release (0.3.1) is outside the pinned `^0.2.50` range and still requires `zod ^3.24.1`.
- Overriding desktop-commander onto zod 4 was tried and reverted. Its `tools/list` then returns input schemas whose `type` is not `"object"`, which breaks the 26-tool `probe:backend` contract.

DEX//REACH's own top-level zod is 4.6.7, which is fixed.

**Exposure:** desktop-commander validates tool arguments with its zod 3. Reaching the advisory needs an authenticated, authorized MCP call to a desktop-commander tool that carries oversized constrained collections. The likely impact is memory exhaustion (denial of service) of the node's compatibility adapter process.
