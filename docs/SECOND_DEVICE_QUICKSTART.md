# DEX//REACH — Second device quickstart

You've decided to try it. Here is everything you do. Nothing runs remotely until *you* turn it on.

## 0. What you need
- Node.js 22 or newer (`node -v`).
- The enrollment file the gateway owner (Andrew) generated for you: `<your-node>.env`. It contains your
  node's private credential — receive it over a private channel (AirDrop, password-manager share), never
  chat or email. Nobody else needs a copy.
- macOS or Linux. (Windows is not supported yet; see the note at the end.)

## 1. Install
```bash
git clone git@github.com:westkitty/DEX-REACH.git
cd DEX-REACH
npm ci
npm run install:node -- --env /path/to/<your-node>.env --roots "$HOME/projects" --service
```
`--roots` is the only folder tree an AI client can ever touch (use `:` to list several).
`--service` keeps the node running in the background (macOS launchd — verified; Linux systemd — generated,
not yet verified on real hardware; leave it off to run manually with `DEX_REACH_ENV_FILE=… npm run node`).

The installer prints `AI access: OFF`. That is the starting state: your machine is enrolled and reachable
for status, but every execution request from any AI client is refused locally.

## 2. Check it
```bash
npm run dex -- status
```
You should see your node ID, `Gateway: connected`, `AI access: DISABLED`, your allowed roots, and which AI
clients are blocked (all of them, for now).

## 3. Let an AI use it — for a while
```bash
npm run dex -- enable --for 30m        # full configured access, then back to off automatically
npm run dex -- read-only --for 2h      # inspection only (no writes, no mutating commands), then off
```
Takes effect immediately; no internet, gateway, or Andrew involved. When the window ends the node refuses
again on its own.

Prefer to keep one client out entirely?
```bash
npm run dex -- client chatgpt off      # ChatGPT blocked even while the node is enabled
npm run dex -- client claude read-only
npm run dex -- client chatgpt default  # remove the limit
```

## 4. Shut it off
```bash
npm run dex -- disable
```
Kill switch. Works offline. Survives node restarts, gateway restarts, and reconnects.

## 5. See what happened
```bash
npm run dex -- audit --limit 50
npm run dex -- audit --client chatgpt
```
Every request: time, which AI client, what operation, which path/command, allowed or refused. File contents
and credentials are never written to the log.

## 6. Remove it completely
```bash
npm run dex -- uninstall                               # stops and removes the background service
npm run dex -- uninstall --purge-state --yes-delete-state   # also deletes your node credential + policy
```
Then delete the `DEX-REACH` folder. Tell the gateway owner to run `npm run nodes -- revoke <your-node>` so the
credential is dead on their side too — but your machine is already unreachable the moment the service stops.

## Notes
- Windows: the node refuses to run shell commands on Windows (`dex.process.run is not supported on win32`),
  and there is no service installer. Not supported yet; don't expect it to work.
- The node only ever connects *outbound* (WebSocket over HTTPS) to the gateway. It opens no listening port.
- Read [TRUST_AND_PRIVACY.md](TRUST_AND_PRIVACY.md) if you want the honest version of what this can and
  cannot do.
