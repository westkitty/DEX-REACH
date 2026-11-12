# DEX//PANIC 0.2.1 — Owner acceptance and recovery proof

Target: **MacBook Air**, owner account, `~/Applications/DEX Panic.app`. This procedure is safe while DEX//REACH is actively serving remote clients **only through Test A and Test B**. Tests C and D require a separately arranged no-work maintenance window. The actual policy and all node permissions remain under device-owner control.

## A — Read-only installation and runtime acceptance (safe now)

1. Open Terminal on **MacBook**, then run exactly:

   ```bash
   APP="$HOME/Applications/DEX Panic.app"
   /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist"
   /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist"
   /usr/bin/shasum -a 256 "$APP/Contents/MacOS/DexPanicApp"
   /bin/ps -axo pid=,comm= | /usr/bin/grep -F "$APP/Contents/MacOS/DexPanicApp"
   ```

   Expected: version `0.2.1`, bundle identifier `com.stinkyweasel.dex-panic`, executable SHA-256 `000ef0fc7554cde33a7a4a78381c2281d7ffbb8223ab902fca2d4beb48bc1050`, and one running process for the **installed** app. This verifies installed byte identity and process presence, not that UI interactions work.

2. In the macOS menu bar, the DEX//PANIC shield should be **bright solid white**, clearly visible on the current dark menu bar, when Gateway/Node/Coordinator all show `running`. After opening the menu, read its last-checked timestamp and refresh status. The optional worker may also show `running`. If any required status is `stopped`, `notInstalled` or `unknown`, the shield should be **red with a white exclamation**. Do not stop a working service just to force the red state. Capture a close screenshot if the white shield is still too dark.

3. Choose **Open Recovery Deck...**. Expected: a resizable dark window, a real last-probe time, four service cards, distinct policy/admission/task-uncertainty panels, and an incident timeline. Scroll down and resize the window; text and controls must remain visible. Click **Run fresh checks** once; verify the time updates and a status change is not invented. Closing the Deck should leave the menu bar shield operable.

4. Choose **Show owner access status**. This is read-only. Expected: an alert with actual owner CLI status; after dismissing, the Deck authority panel should show `ON`, `READ-ONLY`, `OFF VERIFIED` or `NOT VERIFIED`, accurately. Do not equate this with service health. Choose **Inspect coordinator capacity (read-only)**; expect actual status output and `AVAILABLE AT CHECK`, `QUEUED AT CHECK` or `NOT VERIFIED`. Capacity is a snapshot, not a promise of future admission.

5. Choose **Show incident log in Finder**. Expected: Finder opens `~/Library/Logs/DEX-Panic/events.jsonl` if it has entries from prior read-only operations. Events should include action, target and outcome metadata only. If the file does not exist, the app should report it without crashing.

6. While all services remain running, open a service submenu and select **Restart service (review first)...**, then **Cancel** the confirmation. This tests the warning/Cancel path only. **Do not confirm restart.** All services should remain running, and no new task should be replayed.

7. Quit **DEX//PANIC only** from its menu, then relaunch from MacBook Terminal using `open "$HOME/Applications/DEX Panic.app"`. Expected: one shield returns, no Dock app, no DEX service interruption. No automatic login item is promised.

The versioned prebuilt installer also supports `--verify-only`, which exercises archive acquisition, extraction, identity and checksum validation without installation or launching a second app. An existing archive is reused only after hash verification. This mode can be tested while the original app is running. Use the **published 0.2.1 script**; the earlier `~/Downloads/DEX-Panic/Install-Prebuilt-from-BigMac.command` extracted from v0.2.0 is known broken and must not be used to test v0.2.1. If coordinator admission is refused, stop rather than retrying through a different remote route.

## B — Verify the backup without restoring over a running app (safe now)

```bash
ROOT="$HOME/Downloads/DEX-Panic-icon-fix-20261112"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/DEX Panic-v0.2.0-backup.app/Contents/Info.plist"
/usr/bin/shasum -a 256 "$ROOT/DEX-Panic-v0.2.0-rollback.app.zip"
/usr/bin/shasum -a 256 "$ROOT/release.zip"
```

Expected: `0.2.0`, rollback archive SHA-256 `577520219a4d7ca9d50eae3416c4651ee3783702dd9bab7f8319cba1cc57540b`, v0.2.1 release archive SHA-256 `1157ab28f4f6ce5792f1dbf652e2c6633d1d1a2edb874d415959234f87472cdd`. The rollback ZIP was already extracted and byte-checked separately; **do not move it over the installed app during routine testing**. Backup copies are independently held on Big Mac.

## C — Owner-policy OFF/ON behavior (DEFER until no remote tasks)

Do **not** click `STOP NEW REMOTE AI EXECUTION` merely for a quick smoke test. It changes a live owner-enforced policy and can sever the very remote path used to diagnose trouble. Arrange a deliberate maintenance window, confirm current local access and task quiescence, record the exact current owner access mode, run the OFF action once, verify authoritative status separately, then restore the previous mode **manually** according to the current installed DEX CLI documentation. Never blindly retry a timed-out policy command. This test remains unverified until directly performed.

## D — Real service failure / red visual state (DEFER; never on active work)

Swift unit tests already prove the red/white mapping for healthy, degraded and unknown inputs. To prove the **live red appearance** and a real start/restart path, schedule an isolated maintenance fixture or a window in which in-flight effects have been reconciled and a full rollback is ready. Do not kill gateway, node, coordinator or worker during an ongoing connector session. No such disruptive test is claimed by v0.2.1.

## Owner report

Report: (1) white shield actually visible? (2) Recovery Deck usable at normal window size? (3) did owner policy and capacity inspections match CLI output? (4) did Cancel leave all services running? (5) did relaunch restore exactly one status item? A screenshot is useful for UI visibility; no secrets, full logs or credentials are necessary.
