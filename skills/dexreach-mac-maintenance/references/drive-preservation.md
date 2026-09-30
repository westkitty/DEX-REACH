# Google Drive Preservation

## Purpose

Preserve explicitly selected durable material before local removal. This is not a cache-backup system.

## Default

Drive preservation is OFF by default.

Never archive maintenance debris such as package caches, browser payload caches, DerivedData, staging directories, expired leased temp roots, or routine logs.

## Preconditions

Use `drive <n>` only when:

1. the user explicitly chose Drive preservation for that durable menu item;
2. the deterministic kernel prepared a current durable ticket;
3. the target is not protected repository/infrastructure/configuration state;
4. a configured rclone backend of type `drive` is available.

If the archive cannot be verified, keep the local original.

## Destination and identity

The destination remains below:

`GPT/Mac-Maintenance/REMOVAL-ARCHIVE/YYYY-MM-DD/`

A file or directory receives a source SHA-256 suffix. Once the ticket begins archiving, persist the chosen destination in the ticket so retries do not silently move to another date/path.

## Idempotent file state machine

For files, use this order:

`prepared -> remote-check -> uploading -> archived-verified -> removed-after-archive`

`remote-present-unverified` is a blocking state, not permission to overwrite.

Before every upload:

1. compute the current local MD5 after ticket revalidation;
2. inspect the exact remote destination;
3. if one or more existing objects all match the local MD5, reuse that verified remote object and do **not** upload another copy;
4. if an existing object has a different MD5, block;
5. if remote state cannot be established, block rather than overwriting.

After any copy result, including timeout/failure, probe the exact remote destination again before deciding the transfer failed. A matching remote MD5 is valid verification even when the copy command itself timed out after completing remotely.

If multiple exact-destination objects have the same matching MD5, accept the archive as verified but record the duplicate count and do not create another copy.

## Timeout behavior

The kernel owns a bounded copy timeout and a separate verification timeout. Large transfers may be run through a DEX background-process facility when the runtime exposes one, but the operation must still be the exact bundled kernel command.

A timeout never authorizes removal. The post-timeout remote verification determines whether the ticket becomes `archived-verified` or remains local.

## Directory verification

For directories, use `rclone copy` followed by `rclone check --one-way`. Keep the local directory unless the check passes.

## Transport health

Capabilities should surface:

- whether rclone exists;
- configured Google Drive remotes;
- rclone version when available;
- whether a Drive remote relies on the shared/default rclone client ID.

A transport warning is not deletion authority. If the Drive path is degraded, prefer keeping originals over bypassing verification.
