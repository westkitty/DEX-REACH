# DEX//REACH Runtime Contract

## Required order

1. `reach_list_nodes`
2. bind target under machine rules
3. `reach_fingerprint`
4. stage the exact bundled `scripts/dexmaint_remote.py` to `/tmp/dexmaint_remote.py`
5. run `capabilities`
6. compare identity, kernel version, policy version and SHA-256 with `kernel-integrity.md`
7. use only supported kernel commands for maintenance mutations

Do not substitute SSH, Desktop Commander, or freehand remote deletion when DEX//REACH maintenance was requested.

## Standard commands

Read-only status for local UI clients:

`python3 /tmp/dexmaint_remote.py status --target macbook`

The status contract is schema-versioned and reports current APFS free space/pressure, watcher activity, and the most recent persisted run summary. It does not discover candidates, reconcile state, or mutate storage.

Inspect:

`python3 /tmp/dexmaint_remote.py inspect --target macbook`

Plan an amount-to-reclaim goal:

`python3 /tmp/dexmaint_remote.py plan --run <RUN> --mode clean --target-bytes <BYTES>`

Plan an absolute immediate-free goal:

`python3 /tmp/dexmaint_remote.py plan --run <RUN> --mode clean --goal-available-bytes <BYTES> --goal-metric immediately-free`

Plan an absolute DexCleaner available-for-work goal:

`python3 /tmp/dexmaint_remote.py plan --run <RUN> --mode clean --goal-available-bytes <BYTES> --goal-metric available-for-work`

Apply/verify:

`python3 /tmp/dexmaint_remote.py apply --run <RUN> --manifest-sha256 <SHA>`

`python3 /tmp/dexmaint_remote.py verify --run <RUN>`

Menu and selected maintenance:

`python3 /tmp/dexmaint_remote.py menu --run <RUN>`

`python3 /tmp/dexmaint_remote.py plan-selected --run <RUN> --menu-sha256 <MENU_SHA> --numbers 2,4`

Durable lane:

`python3 /tmp/dexmaint_remote.py prepare-selected-durable --run <RUN> --menu-sha256 <MENU_SHA> --number <N>`

`python3 /tmp/dexmaint_remote.py archive-drive --target macbook --ticket <TICKET> --remote gdrive:`

For a large archive, an explicitly supported DEX background-process facility may run this exact kernel command and be polled to completion. Do not replace it with an ad hoc rclone command. The kernel's archive operation is idempotent and rechecks the exact destination before upload and after timeout/failure.

## Deep hidden-space reconnaissance

When the user asks to go deeper after ordinary inspection, stage and run the exact bundled `scripts/storage_hotspot_scan.py` only against a bounded root selected from prior hotspot evidence. Never use it to grant mutation authority; feed exact candidates through `candidate-promotion.md` first.

## Big Mac

Append `--bigmac-ack BIG-MAC-EXPLICIT-CURRENT-REQUEST` to every supported Big Mac action. Never reuse acknowledgement from an earlier turn.
