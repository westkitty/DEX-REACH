# DEX//REACH — Trust and privacy, plainly

Written for someone deciding whether to install a node on their own computer.

## The one-sentence model
Installing a DEX//REACH node makes your machine *reachable for status*; it does not let any AI do anything
until you flip a switch on the machine itself, and that switch is enforced by the node process on your
machine — not by ChatGPT's settings, not by the gateway, not by Andrew.

## What can ChatGPT (or Claude, or any MCP client) do?
Only what the node's local policy allows, and only inside the folders you listed as allowed roots:
- **AI access OFF** (the default after install): nothing. Every request is refused by your node with
  `NODE OWNER has disabled remote AI execution on this node`. The client still sees your node in the
  list with `aiAccess: off`.
- **READ-ONLY**: read files under your roots, run a fixed list of inspection commands (`pwd`, `ls`,
  `cat`, `git status`, …), get a machine fingerprint, list ADB devices. Writes, file edits, directory
  creation, non-inspection commands, and Git checkpoints are refused.
- **ON**: the node's configured profile applies (e.g. `development`): read/write files under your roots,
  run bounded shell commands under your roots (60 s max, output capped), Git inspection/checkpoints,
  and the compatibility adapter's tools (search, edit, interactive processes) — all path-scoped.
- **Per client**: you can additionally cap or block one client kind (ChatGPT / Claude / other) while
  leaving another allowed. A cap only ever lowers access.

## What can it NOT do?
- Read or write outside your allowed roots (checked on every path argument, including the
  compatibility adapter's).
- Run `sudo`, `rm -rf`, disk formatting, shutdown/reboot, `git reset --hard`, `git clean -f`,
  `git push --force` — blocked by pattern regardless of mode.
- Change its own allowed roots or profile remotely. Those live in a file only you can edit.
- Run anything on your machine while access is OFF, or while a timed window has expired.
- Reach a different machine by accident: every request names a `node_id`; unknown, offline, or revoked
  IDs fail. There is no default node and no fallback.

## Does installing this expose a shell to the internet?
No. The node opens **no listening port**. It makes one outbound WebSocket connection (TLS) to the
gateway and authenticates with its own per-node credential. The public HTTPS endpoint belongs to the
gateway (Andrew's machine), which only accepts OAuth-authenticated MCP requests from clients Andrew
approved.

## Who controls what
| Thing | Who |
|---|---|
| Whether AI can execute at all, and read-only vs full | You, locally (`npm run dex -- enable/read-only/disable`) |
| Timed windows (`--for 30m`) | You, locally |
| Per-client limits (ChatGPT vs Claude) | You, locally |
| Allowed roots and execution profile | You, in your node's `.env` file (restart the node to apply) |
| Which AI clients may talk to the gateway at all | Andrew (gateway OAuth approval) |
| Revoking your node's credential | Andrew (gateway) — *and* you can delete it locally |

## Can Andrew still access my machine?
Not through DEX//REACH unless your node policy allows it. Andrew's access is via the same AI clients
and hits the same node-side gate. He cannot change your policy file; it is on your disk. He *can*
revoke your node (which only disconnects it).

## Can I shut ChatGPT out without Andrew?
Yes. `npm run dex -- disable` (or `client chatgpt off`) is read by your node before every request. No
network, gateway, or account is involved. It survives node/gateway restarts and reconnects.

## Can I uninstall it?
Yes, entirely locally: `npm run dex -- uninstall --purge-state --yes-delete-state`, then delete the
folder. The gateway does not need to be online.

## What if …
- **the gateway is compromised?** An attacker could send requests to your node *as any approved client*.
  Your node still enforces OFF / READ-ONLY / roots / command guards. With access ON, they get what an
  approved AI would get. Keep access OFF or time-boxed when not in use; that is the design.
- **ChatGPT (or another AI client) is compromised or tricked?** Same boundary: it can only do what your
  local policy allows, inside your roots, with destructive commands blocked. Prompt-injection risk is real
  when access is ON; that is why per-client caps and timed windows exist.
- **my node credential leaks?** Someone could run a fake node claiming to be you (and receive requests
  meant for you). They could not reach *your* machine with it. Fix: `npm run nodes -- revoke` on the
  gateway and re-enroll. Credentials are stored mode 0600 and only hashes live on the gateway.
- **Andrew's owner password leaks?** New AI clients could be approved at the gateway. Your node policy
  still applies to all of them.

## Are commands logged? Where?
Yes, on your machine: `~/.dex-reach/audit.jsonl` (one JSON line per request: time, client kind and name,
operation, path/command, allowed or refused, error). The gateway keeps its own copy of what it *routed*.
**Not** logged: file contents written or read (only byte counts), credentials, tokens, cookies.
`npm run dex -- audit` shows it.

## Inbound or outbound?
Outbound only, from your node to the gateway (`wss://…/node`), reconnecting automatically.

## What data goes to ChatGPT?
Exactly the results of the actions it ran and that your node allowed: file contents it read, command
output, fingerprint (hostname, user, home, cwd, git remote, runtime versions), node list (node IDs,
allowed roots, profile, access mode). ChatGPT keeps that in its conversation on OpenAI's side.

## What does NOT go anywhere?
Your node credential, your policy file, files outside your roots, and anything while access is OFF.
The compatibility adapter runs with telemetry disabled in an isolated home directory.

## Known limits (honest)
- Client attribution ("ChatGPT asked") comes from the OAuth client's registered name, which Andrew sees
  and approves once at the gateway. It is attribution, not cryptographic proof.
- READ-ONLY is a curated allow-list of inspection commands; anything not on it is refused (so it may refuse
  a harmless command — that is the safe direction).
- Only macOS service installation has been exercised on real hardware. Linux systemd unit generation is
  implemented but unverified. Windows is unsupported.
- No second physical device has been enrolled yet; multi-node behavior was proven with a second node
  process running under an isolated state directory on the same Mac, driven through the real gateway
  and real ChatGPT.
