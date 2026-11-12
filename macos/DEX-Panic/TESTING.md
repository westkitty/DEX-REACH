# DEX//PANIC v0.3.0 — MacBook-only operator acceptance

This release has **one MacBook menu-bar UI**. Big Mac is a read-only information source and has no DEX//PANIC `.app`, menu bar icon, login item or new service. The Big Mac installed DEX node remains unchanged.

**Before installing**: the existing MacBook v0.2.3 app binary must have SHA-256 `51502a7a20947d6d67d724710e71cab182a780259700eab56f6f2e58f01a31a5`; the checksum-locked `Upgrade-DEX-Panic.command` preserves that app before replacing it. The new v0.3.0 binary must have SHA-256 `6ded1cf197b2759982186acd032e7352585555e3ec6edaf4e905df8b219b7137`. MacBook launch/GUI are not proven from Big Mac compilation.

1. In MacBook Terminal, check the installed app's `CFBundleShortVersionString`, exact binary hash and process. Do not accept the release if the hash differs or multiple apps are running.
2. Open the white/red shield and Recovery Deck. Confirm required Gateway, Node and Coordinator still render truthfully; optional Worker may be unknown. The shield stays **red** on any unknown required service, and **white only on fresh positive liveness**.
3. In `WHAT THE CHECK FOUND`, confirm per-service probe milliseconds, last positive liveness and cycle duration. A timeout remains unknown, not stopped or healthy. Opening the menu repeatedly inside eight seconds must not trigger an extra refresh; explicit `Try checks again` does.
4. Under `COMPETING WORK`, inspect MacBook and Big Mac separately. The top-CPU/RSS shortlist is *not* asserted to equal the coordinator count. Big Mac connection failure must show UNAVAILABLE.
5. Under `COORDINATOR ATTRIBUTION`, use the manual read-only button for each selected host. Count, grouped names, CPU/memory threshold and group size should appear if the coordinator returned complete evidence; otherwise show incomplete/unavailable, not guessed attribution.
6. Under `DURABLE TASK AUTOPSY`, inspect each host. Verify `AMBIGUOUS` and `INPUT_REQUIRED` advise owner input and no replay; `COMPLETED` is a recorded state, not proof of external effects. This pane has NO retry, resume, cancel, kill or policy-change action.
7. Choose `Copy diagnostic report`. Review before sharing. It should contain timestamps, probe timing, both process samples, classified grouping and recent task state *only after each has been explicitly inspected*. It must contain no commands, PIDs, private paths, credentials or task payloads.
8. Keep DEX services running. Do not intentionally stop or restart anything for routine acceptance. Full installed-MacBook performance profiling and SSH end-to-end GUI verification remain separate user acceptance gates.

On Big Mac, the only new behavior is the owner-local read-only CLI in the isolated source checkout:
`cd /Users/bigmac/DEX-Panic-0.3.0-Release-20261112 && /opt/homebrew/bin/npm run dex -- work-status --panic` or `npm run dex -- tasks --panic`.
Its output schema is 1 and supplies bounded, redacted data; there is no Big Mac UI installation or service restart.

---

# DEX//PANIC v0.2.3 — Owner acceptance for competing work (read-only)

Target MacBook App: `~/Applications/DEX Panic.app`. This test is safe when DEX services remain active because **no processes or policies are modified by Inspect competing work**.

1. Confirm installed version `0.2.3` and the expected SHA-256 `51502a7a20947d6d67d724710e71cab182a780259700eab56f6f2e58f01a31a5` before accepting any UI result.
2. Open Recovery Deck → **04 / COMPETING WORK**. Choose **Inspect competing work**. Verify separate **MacBook Air** and **Big Mac** selectors. No kill, terminate, pause, restart or priority-change action should appear inside this section.
3. For MacBook, expect a timestamped status and bounded list with process basenames, sampled CPU%, RSS MiB and explanations. A generic `node` or `python` must not be claimed to belong definitively to DEX.
4. Switch to Big Mac. If `westcat` and remote account/host trust pass, expect an independent timestamped list. If remote login/identity fails, expect **UNAVAILABLE**, never MacBook data relabeled as Big Mac.
5. Inspect work admission separately and compare with the list. The coordinator's uncoordinated-heavy count does **not** identify exactly the displayed process rows.
6. Use **Copy diagnostic report**. The copied text should include separately labeled MacBook and Big Mac process snapshots, timestamps and bounded process metrics, but NO raw paths, process arguments, credentials, user IDs or PIDs. Review before sharing.
7. Quit and reopen DEX//PANIC only to verify the original white/red service-liveness shield and manual Recovery Deck behavior remain intact. Do not intentionally stop any DEX services, disable access, terminate a process, or induce memory pressure for testing.

**Known limitation:** CPU and RSS are snapshots, not attribution. Processes may exit between checks; memory RSS is not additive across all processes. Remote inspection only runs on explicit click, via owner-authorized SSH, and Big Mac node-local AI authority remains unchanged.

---

# v0.2.2 manual acceptance — diagnosed service uncertainty

The following is for the **MacBook**, after the v0.2.2 application has been explicitly installed. Do not assume it is installed solely because it was compiled on Big Mac. Keep DEX//REACH services and owner policy unchanged during routine acceptance.

1. Open the DEX//PANIC shield, select **Open Recovery Deck**, and locate **02 / WHAT THE CHECK FOUND**. It must name the exact observation class and explain whether the app witnessed a genuine stopped service or only failed to check in time.
2. When any service reads UNKNOWN / Probe timed out, the explanation must say **4-second launchctl deadline, not proof of stopped services**. It should offer **Try checks again**, **Inspect capacity**, and no automatic restart.
3. Select **Inspect capacity**. If the CLI returns evidence, the Deck should show a last-inspected memory/CPU/heavy-work summary. If the CLI cannot produce evidence, it must say **not verified** rather than invent values.
4. Select **Copy diagnostic report**. The Deck should confirm that the clipboard copy succeeded. Paste into a text editor or this chat *after reviewing it*. Verify that report has timestamp, check age, all four service states, meaningful failure reasons, last capacity/owner inspection dates, typed resource summaries, and bounded recent transitions. It must NOT contain credentials, policy-file paths, raw CLI output, raw audit text, secrets or process IDs.
5. After copying, choose **Inspect owner policy**. The alert should explain ON / READ-ONLY / OFF / NOT VERIFIED in plain English, not display raw CLI text. Copy again if you want a refreshed owner-policy reading.
6. The menu bar remains operable if the Deck window is closed. `Copy share-safe diagnostic report` in the menu must also copy the report. No service action is required to test this.
7. Do NOT intentionally stop a daemon, confirm a service restart or click `STOP NEW REMOTE EXECUTION` to test this feature; those actions affect active work and are separate maintenance tests.

## Build verification evidence

Big Mac v0.2.2 native arm64 build verified; 26/26 macOS Swift tests passed, including secret-injection and unknown-state behavior. MacBook UI, clipboard and upgrade path are NOT yet owner-verified.

---

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
