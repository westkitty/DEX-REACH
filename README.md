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

## Client state

Claude Code can be registered directly with `claude mcp add --transport http --scope user dex-reach https://macbook-air.tailafb7e8.ts.net/mcp` and OAuth-authenticated with `claude mcp login dex-reach`. ChatGPT Business custom full-MCP deployment is performed through workspace Developer Mode / Apps using the same `/mcp` URL; DEX//REACH does not require vendor-specific server code.
