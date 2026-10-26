# Big Mac node-only upgrade

This runbook stages the Big Mac node without replacing the MacBook gateway or changing the
existing Big Mac node credential file, owner policy, profile, or allowed roots.

## Stage and validate

Run the staging command from the verified candidate checkout on Big Mac:

```sh
npm run bigmac:stage-node-upgrade
```

The command requires the `bigmac` macOS account and host, the existing `bigmac` node identity,
the existing `/Users/bigmac` root, a running `com.stinkyweasel.dex-reach.node` LaunchAgent,
at least 2 GiB free, and a candidate version newer than 0.3.2. It builds a versioned immutable
release, snapshots the current checkout-backed 0.3.2 runtime into the private runtime releases
directory, and stages node-only candidate and rollback LaunchAgent definitions. It does not run
`install:macos`, write the active LaunchAgent, reload launchd, rewrite credentials, or change policy.

The private manifest is written to:

```text
~/.dex-reach/runtime/bigmac-node-upgrade/<candidate-release-id>/manifest.json
```

It omits credential values. The credential file remains at its existing path and is referenced
unchanged by both staged service definitions. The staged candidate LaunchAgent contains only the
node label and node entry.

## Explicit activation

Live activation requires separate owner authorization. When authorized, the exact candidate can be
scheduled through its independent launchd helper with:

```sh
npm run bigmac:activate-node-upgrade -- --transaction <candidate-release-id> --authorize-live-deployment bigmac
```

The helper refuses a changed active LaunchAgent, verifies both release hashes, and checks the
production dependency audit and existing gateway before replacing the node. It watches for process
restarts, bounds gateway reconnection to 120 seconds, and restores the previous immutable node
release on a failed replacement. After helper completion, the owner must still confirm the exact
`bigmac` node and protocol through the MacBook gateway. A helper status of
`awaiting_exact_node_verification` is not deployment completion.

At the 2026-10-25 candidate check, `npm audit --omit=dev --audit-level=high` reports a high severity
Zod advisory in Desktop Commander's nested Zod 3 dependency. The candidate activation helper
therefore refuses activation until a clean production audit is available.

## Deployment gate

Do not run the activation command without the owner's explicit live deployment authorization.
Verify exact `bigmac` reconnection and protocol negotiation through the MacBook gateway before
considering activation complete.

## Offline rollback

If a later authorized activation leaves the candidate LaunchAgent installed but the node unhealthy,
the SSH recovery route can run the independent rollback command on Big Mac:

```sh
npm run bigmac:rollback-node-upgrade -- --transaction <candidate-release-id> --confirm-node-only-rollback bigmac
```

Rollback refuses unless the active node LaunchAgent still byte-matches that transaction's candidate,
both immutable releases pass integrity checks, and the saved previous node-only LaunchAgent points
to the verified previous release. The command reports launchd process restoration; gateway
reconnection still requires a separate exact-node check through DEX.

The original checkout-backed service definition is also retained in the transaction's private
baseline directory. Candidate and rollback commands never create a gateway, coordinator, worker,
or other DEX service on Big Mac.

## Native backend candidate closeout

The 2026-10-26 candidate source now selects the DEX native compatibility backend.
Its clean production install contains no Desktop Commander package; production audit
reports zero vulnerabilities and the prior advisory exception is retired. The
installed Big Mac node remains unchanged. See [native backend evidence](native-backend-evidence/PARITY.md)
for the 22-tool matrix, exact source/artifact checks and remaining deployment boundary.

Build packages the runtime assets automatically. Source-node startup and npm test
build first so they use that same verified package. These build/test hooks do not
install or activate a node service. The explicit deployment authorization above still applies.
