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
- filesystem read/write/edit/search through the compatibility adapter
- long-running terminal/process sessions with process input/output
- Git/repository inspection and recoverable worktree checkpoints
- Android ADB discovery
- configurable operating profiles and allowed roots
- destructive-command guardrails
- redacted JSONL audit trail
- bounded large-result continuation handles
- node revocation
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
Secrets live at `~/.dex-reach/secrets.env` with mode `0600`; bootstrap does not write them into the repository or print the generated password/token.

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

`npm run smoke` performs an OAuth/PKCE MCP connection and routes real file and process operations through the local REACH node.
