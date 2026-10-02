# Mac installation, update, and recovery

Use a **local terminal**, Node.js 22+ and npm 11.19.1 (CI baseline; this Mac uses Node 26).
Keep existing owner credentials and policy. No install command rotates credentials or widens access.

```sh
cd /Users/andrew/DEX-REACH
git pull --ff-only
npm ci
npm run install:macos:wait
# Later, including after login/reboot:
npm run healthz:assert
npm run dex -- status
```

`npm run update:macos` combines pull, npm ci, installation, and health. Stop on any nonzero exit;
if pull requires reconciliation, resolve it separately without force/reset/stash. Unrelated dirty
files remain untouched. **Legacy migration:** before npm ci/build, run `install:macos:wait` if
`launchctl print gui/$(id -u)/com.stinkyweasel.dex-reach.gateway` still lists checkout `dist/`.
The working directory must become `~/.dex-reach/runtime/releases/<release>`.

`install:macos` alone returns **scheduled**, allowing a DEX-hosted caller to receive its response
before self-replacement. Check separately with `npm run healthz:assert -- --wait-install`; never
block on self-replacement inside a remote DEX request. Identical build inputs reuse their private
release; repeated installs reconcile/restart services. Concurrent installers serialize and await
an active earlier reload. Installation compiles directly into private staging and validates every
entry before replacing services; ordinary checkout `dist/` rebuilds do not affect live services.
Node launches after gateway readiness. Agents use the stable Homebrew Node alias when it selects
the current executable, avoiding a removed versioned Cellar binary after Homebrew upgrades.

Canonical configuration: `~/.dex-reach/secrets.env` for gateway owner settings and
`~/.dex-reach/nodes/<node-id>.env` for enrollment. `DEX_REACH_STATE_DIR` selects isolated state;
`DEX_REACH_ENV_FILE` selects a startup file. Gateway/node agents explicitly select their own files.
The owner password needs 16+ characters; node token needs 24+, matching identity and local gateway
`/node` URL. Quoted env values use Node's parser. Keep files 0600; never paste or commit contents.
After intentional rotation, reconcile the correct file and gateway enrollment record, then reinstall.
Further password/token rotation requires owner approval. Missing/invalid keys fail before reload.

Health waits **60 seconds**, requiring five seconds of unchanged process IDs/run counts, complete
installed entries, live matching processes, fresh connected node status, `ok:true`, **onlineNodes:1**,
AI **ON**, and runtime **full-local**. Exit 78 since service reload prevents green; old error-log
text alone does not. Helper completion also requires the public OAuth refresh canary to exit 0
(30-second limit). `--wait-install` allows 180 seconds for the helper, then the local settle check.
Health never changes owner policy. Public HTTPS ingress failures remain separate failures.

| Failure | Fix |
| --- | --- |
| Checkout `MODULE_NOT_FOUND` | `npm run install:macos:wait` rebuilds privately; do not restore checkout-backed launchd definitions. |
| Incomplete private release | Run `install:macos:wait`; installer preserves it and builds a verified repair release. Repeating install reuses that repair. Never remove a running release. |
| `EX_CONFIG` / exit 78 | Repair the named key in the named file using existing owner/enrollment settings, then reinstall. No blind credential rotation. |
| Gateway up / node down | Validate enrollment file, reinstall, assert health. |
| `onlineNodes:0` / reconnect pending | Let health wait; on timeout inspect gateway URL and enrollment/revocation. HTTP 200 alone is insufficient. |
| AI disabled / wrong profile | Inspect `dex status`; restore only the intended owner settings. Installer preserves authority. |
| Failed/stalled helper or canary | Inspect `~/.dex-reach/install-macos.status.json` and local helper/canary logs; resolve its error and reinstall. Keep secrets private. |

Regression: `npm run verify` includes config/health tests and compiled-entry assertions; CI asserts
entries after build. `npm run healthz:assert -- --wait-install` is the installed Mac gate. LaunchAgents
start after owner login; service cold-stop proof is separate from an actual reboot/login test.
