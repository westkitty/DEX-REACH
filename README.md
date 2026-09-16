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

## Enrolling a second device (another person's machine)

Every node is an independent identity: its own node ID, its own credential, its own allowed roots, its own
profile, and its own locally detected fingerprint. Nothing in routing assumes a particular machine; every
MCP action takes an explicit `node_id` and the gateway refuses to route to a node that is not online under
that exact ID, so a command aimed at one machine never silently runs on another.

Workflow (gateway owner = Andrew; new device owner = e.g. Bryan):

1. **Gateway owner enrolls the node** (on the gateway machine):
   ```bash
   npm run nodes -- enroll bryan-laptop --profile development --roots /Users/bryan
   ```
   This writes `~/.dex-reach/nodes/bryan-laptop.env` (mode 0600) containing the node ID, the freshly
   generated token, the profile, the allowed roots, and the public `wss://…/node` gateway URL. Only the
   SHA-256 hash of the token is kept in `node-auth.json`; the plaintext exists only in that env file.
2. **Transfer the env file securely** to the new device (AirDrop, password manager share, an encrypted
   channel — never Git, chat, or email). Delete the copy on the gateway machine afterwards if desired; the
   gateway does not need it. Adjust `DEX_REACH_ALLOWED_ROOTS` to that machine's real paths.
3. **Install the node on the new device** (Node.js 22+):
   ```bash
   git clone git@github.com:westkitty/DEX-REACH.git && cd DEX-REACH && npm ci && npm run build
   mkdir -p ~/.dex-reach/nodes && mv /path/to/bryan-laptop.env ~/.dex-reach/nodes/ && chmod 600 ~/.dex-reach/nodes/bryan-laptop.env
   DEX_REACH_ENV_FILE=~/.dex-reach/nodes/bryan-laptop.env node dist/src/node/main.js
   ```
   The node detects its own hostname, user, platform, architecture, and runtime, and connects **outbound**
   over WebSocket to the gateway. No inbound port, SSH exposure, or shell listener is required on the new
   device.
4. **Verify from the gateway side**: `curl https://<gateway>/healthz` reports the new online node count, and
   `reach_list_nodes` from ChatGPT or Claude lists `bryan-laptop` separately with its own fingerprint.
5. **Select it explicitly** in the AI client (`node_id: "bryan-laptop"`). Revocation (`npm run nodes -- revoke bryan-laptop`
   or the `reach_revoke_node` action) affects only that credential.

Platform status (honest): the node runtime is portable Node/TypeScript and the protocol is OS-agnostic.
Persistent service installation is implemented and verified only for macOS `launchd`
(`npm run install:macos`). Linux (systemd) and Windows (Task Scheduler / service) adapters are not yet
written; on those platforms run the node manually or under your own supervisor. Bounded process execution
uses a POSIX login shell (`/bin/zsh` on macOS, `/bin/sh` elsewhere, override with `DEX_REACH_SHELL`) and
refuses to run on Windows until a Windows executor exists. The compatibility adapter is a Node package and
starts wherever Node runs, but has only been exercised on macOS.

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

Claude Code can be registered directly with `claude mcp add --transport http --scope user dex-reach https://macbook-air.tailafb7e8.ts.net/mcp` and OAuth-authenticated with `claude mcp login dex-reach`.

ChatGPT Business: create the custom MCP app under Workspace Settings → Apps → Create (Server URL = the
public `/mcp` URL, Authentication = OAuth, registration = Dynamic Client Registration, default scope
`mcp:tools`). The app's action list is populated only after an admin **connects** the app (user-side
Settings → Apps → DEX//REACH → Connect), which runs the OAuth flow against the DEX authorization page; the
owner credentials are `DEX_REACH_OWNER_USER` / `DEX_REACH_OWNER_PASSWORD` from `~/.dex-reach/secrets.env`.
Once a link exists, Manage app → Configure actions → Refresh pulls `tools/list` and the actions appear
with titles and read/write classification derived from MCP tool annotations. Without a connected link the
app shows "0 actions" and Refresh is disabled — that is not a server fault.
