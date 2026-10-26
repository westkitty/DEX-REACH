# Production dependency audit exceptions

**Exceptions are owner approvals, not fixes.** The candidate currently has no production audit exceptions; historical regression fixtures remain for the retirement policy.

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

None in the candidate source as of 2026-10-26.

GHSA-mrhx-c7xc-m3w5's approved Desktop Commander/Zod 3 exception was retired after
the native backend passed its pre-switch functionality/security gate. Production
startup now selects the independently packaged DEX backend; its dependencies are
declared directly, including fixed Zod 4.6.7. Desktop Commander 0.2.52 remains only
a development reference for isolated differential tests.

This changes candidate source, not the installed Big Mac node. The exception
machinery and historical advisory regression fixtures remain intact. Production
acceptance requires a clean isolated production install and raw production audit.
See [native backend evidence](../native-backend-evidence/PARITY.md).
