# DEX//REACH

DEX//REACH is a secure AI-native remote-computing control plane. It provides one remote MCP surface for authorized AI clients while routing work to explicit machine nodes instead of depending on another vendor's hosted relay.

## Architecture

```text
ChatGPT / Claude / MCP clients
          |
          v
Streamable HTTP MCP + OAuth / PKCE
          |
     DEX//REACH Gateway
          |
 authenticated WebSocket router
          |
      REACH Nodes
          |
 scope + guard + audit + bounded output
          |
local compatibility backend / native bridges
```

The initial local compatibility adapter is pinned to MIT-licensed `@wonderwhy-er/desktop-commander` 0.2.50. DEX//REACH owns the gateway, authorization, node protocol, routing, audit, safety policy, checkpoints, native bridges, and remote MCP endpoint.
## Baseline capabilities

- explicit multi-node registry and node selection
- machine/repository/runtime execution fingerprints
- DEX-native bounded UTF-8 file read/write with allowed-root enforcement
- DEX-native guarded bounded process execution
- compatibility-adapter filesystem/edit/search and long-running interactive process sessions
- Git/repository inspection and recoverable worktree checkpoints
- Android ADB discovery
- configurable operating profiles and allowed roots
- destructive-command guardrails
- redacted JSONL audit trail
- bounded large-result continuation handles
- per-node enrollment credentials, bounded rotation grace, and node revocation
- stateful MCP Streamable HTTP transport
- dynamic OAuth client registration, PKCE, refresh rotation, token revocation, and protected-resource metadata

## Local setup

```bash
npm install
npm run bootstrap -- --public-url http://127.0.0.1:8787
npm run gateway
# separate terminal
npm run node
# separate terminal
npm run smoke
```
Gateway/owner secrets live at `~/.dex-reach/secrets.env`. Node credentials live separately under `~/.dex-reach/nodes/<node>.env`; credential hashes are stored in `~/.dex-reach/node-auth.json`. All are mode `0600`, and plaintext node tokens are never stored in Git or printed by the credential CLI.

## Node enrollment and rotation

```bash
npm run nodes -- list
npm run nodes -- enroll bigmac --output ~/.dex-reach/nodes/bigmac.env --profile development --roots /Users/andrew
npm run nodes -- rotate bigmac --grace-seconds 600
npm run nodes -- revoke bigmac
```

`rotate` keeps the prior credential valid only for the requested grace window, allowing a node to reload the new credential without restarting the gateway. The gateway refreshes persisted credential state on new node connections, so rotation is node-local rather than fleet-wide.

## Node-local AI access control (the owner's switch)

Every node enforces its own policy file (`~/.dex-reach/nodes/<node>.access.json`) before running any
request, regardless of which AI client or gateway asked. Modes: `off` (everything refused), `read-only`
(inspection only), `on` (configured profile). Timed windows (`--for 30m`) revert automatically; per-client
caps can block or limit ChatGPT, Claude, or other clients individually. A freshly enrolled node starts
`off`; a missing or corrupt policy file also means `off`.

```bash
npm run dex -- status
npm run dex -- enable --for 30m
npm run dex -- read-only
npm run dex -- client chatgpt off
npm run dex -- disable
npm run dex -- audit --limit 50
npm run dex -- uninstall [--purge-state --yes-delete-state]
```

None of these need the gateway or the internet. See `docs/TRUST_AND_PRIVACY.md`.

## Enrolling a second device (another person's machine)

Every node is an independent identity: its own node ID, credential, allowed roots, profile, policy file,
and locally detected fingerprint. Every MCP action names a `node_id`; unknown, offline, or revoked IDs fail
and nothing ever falls back to another node.

1. **Gateway owner enrolls the node:** `npm run nodes -- enroll bryan-laptop --profile development`
   → writes `~/.dex-reach/nodes/bryan-laptop.env` (mode 0600, `DEX_REACH_INITIAL_ACCESS=off`). Only the
   token hash stays in `node-auth.json`.
2. **Transfer that file privately** to the device owner (never Git/chat/email).
3. **Device owner installs:** `npm ci && npm run install:node -- --env bryan-laptop.env --roots ~/projects --service`
   (macOS launchd verified; Linux systemd unit generated but unverified; Windows unsupported). The node
   discovers its own hostname/user/platform and connects outbound. AI access starts **off**.
4. **Device owner enables when wanted:** `npm run dex -- enable --for 30m`.
5. **Revocation is independent:** gateway-side `npm run nodes -- revoke bryan-laptop` (connected nodes are
   dropped within seconds) or the `reach_revoke_node` action; device-side `npm run dex -- uninstall`.

Short version for the device owner: `docs/SECOND_DEVICE_QUICKSTART.md`.

## Public HTTPS for ChatGPT / Claude

Keep the gateway bound to localhost and put TLS in front of it. On a Tailscale machine, Funnel can proxy the gateway over public HTTPS:

```bash
tailscale funnel --bg --yes 8787
```

After Funnel reports the public `https://<node>.<tailnet>.ts.net` hostname, set `DEX_REACH_PUBLIC_BASE_URL` in `~/.dex-reach/secrets.env` to that HTTPS origin and restart the gateway. Expose only the authenticated gateway; do not expose a raw shell port.

## Safety position

Remote Desktop Commander remains installed until DEX//REACH passes real-client parity validation. DEX//REACH does not force-push, silently widen path scope, log credentials, or provide an unauthenticated remote shell.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run smoke
```

`npm run smoke` performs OAuth/PKCE over the public MCP endpoint, verifies fallback compatibility routing, exercises DEX-native file and process operations, invokes ADB discovery, and creates a recoverable checkpoint from a deliberately dirty disposable Git repository.

`scripts/sim-two-nodes.ts` runs a second node under an isolated `DEX_REACH_STATE_DIR` against the live gateway and proves explicit routing, per-node roots, node-local off/read-only/on enforcement, per-client caps, audit attribution, and no-fallback behavior (24 checks).

## Client state

Claude Code can be registered directly with `claude mcp add --transport http --scope user dex-reach https://macbook-air.tailafb7e8.ts.net/mcp` and OAuth-authenticated with `claude mcp login dex-reach`.

ChatGPT Business: create the custom MCP app under Workspace Settings → Apps → Create (Server URL = the
public `/mcp` URL, Authentication = OAuth, registration = Dynamic Client Registration, default scope
`mcp:tools`). The app's action list is populated only after an admin **connects** the app (user-side
Settings → Apps → DEX//REACH → Connect), which runs the OAuth flow against the DEX authorization page; the
owner credentials are `DEX_REACH_OWNER_USER` / `DEX_REACH_OWNER_PASSWORD` from `~/.dex-reach/secrets.env`.
Once a link exists, Manage app → Configure actions → Refresh pulls `tools/list` and the actions appear
with titles and read/write classification derived from MCP tool annotations. Without a connected link the
app shows "0 actions" and Refresh is disabled — that is not a server fault.
