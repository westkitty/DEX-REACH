# C15 retained runtime provenance (2026-10-28)

PR #26's first recovery verifier took the expected digest of a retained pre-native release from that release's own rollback snapshot. The snapshot is unsigned JSON in an owner-private directory, so anyone running as the owner can write a schema-valid snapshot naming the digest of a tree they built. Against PR #26's head `29ba0e7`, a fabricated 0.4.0 tree containing an implanted `dist/src/gateway/main.js` and a matching fabricated snapshot **was accepted**. Permissions and self-consistency are not provenance.

The repair moves the anchor out of the host. `TRUSTED_RUNTIME_RELEASES` in `scripts/lib/runtime-rollback.ts` pins each admissible retained release by ID, full source SHA and complete-tree digest. Adding or changing a pin is a reviewed source change. A rollback snapshot is now transaction metadata only. Its recorded digest must equal the pin, and it can never add an entry to the table. Against the same fabricated tree, the repaired verifier refuses with `rollback transaction digest ... does not match the reviewed pin`.

## How each pin was established

Each release ID is `version-<commit12>-<lockfile sha256 prefix 12>`, which binds a source commit and a lockfile but not the built tree. The complete-tree digest was therefore established by rebuilding: `npm run release:reproduce -- --source <sha> --release-id <id> --compare <installed tree>`. The tool exports the commit with `git archive`, runs `npm ci` against its committed lockfile (npm's default install-script policy, the same as the original installer checkout), and builds with *that commit's own* `buildRuntimeRelease`. It then hashes the result with `runtimeTreeSha256`, which covers paths, modes, file contents and link targets but no timestamps. Both rebuilds were byte-identical to the installed trees on the first independent run (manual) and again through the tool. Environment: node v26.11.1, npm 11.20.0, darwin/arm64, MacBook-Air.local.

| Release | Source (reviewed merge) | Complete-tree SHA-256 | Evidence | Classification |
| --- | --- | --- | --- | --- |
| `0.3.2-87a99494ebb3-2f44ae46b11b` (C13 Last Known Good) | `87a99494ebb3471d3ecc3a79acd630ec18858a92`, PR #17 merged 2026-10-11T09:30:31Z | `fcb78a6b99db10aac565a1b2b4af90faf142ef5bd5162523a662febeafd36b12` | (1) Same digest committed as `RETAINED_TREE` in `0f13a9e`, published on GitHub through PR #17 two weeks before the dispute. (2) The 0.4.0 install snapshot of 2026-10-24 independently re-measured the same value as its previous release. (3) Byte-exact rebuild from reviewed source on 2026-10-28. (4) Live tree hash matches. | **INDEPENDENTLY CORROBORATED** |
| `0.4.0-274ba16e058e-2d5b454853af` (installed) | `274ba16e058e2b1e855a8ae4a5c30ad63ea81363`, PR #22 merged 2026-10-24T15:13:36Z | `aa966f25b316de98a696ad740c27f82e63454cb5cc988ddbae62c65685e99280` | (1) Byte-exact rebuild from reviewed source on 2026-10-28. (2) Live tree hash matches. (3) The local install snapshot (transaction `5cce83f0-9f8a-46d6-b948-28391950c131`, 2026-10-24T19:03Z) records the same value but is self-referential and carries no weight. No record existed outside the host before this dispute. | **INDEPENDENTLY CORROBORATED** (reproduction only) |

Neither release is classified HISTORICALLY AUTHENTICATED. No signed or third-party attestation was issued when either was installed, and the C13 GitHub record is a same-owner measurement, published afterwards. Reproduction proves that the bytes present now are exactly what the reviewed commit and its lockfile-pinned dependencies build. It does not prove what was present between installation and today. That gap does not matter for recovery, because recovery runs the bytes present now. As the README notes, reproducibility is also not correctness: a compromised upstream package reproduces perfectly.

Rejected candidate anchors:

- **Local rollback snapshots:** SELF-REFERENTIAL (owner-writable, unsigned).
- **File timestamps:** editable, not chronology.
- **Release IDs alone:** bind the commit and lockfile, not the tree.
- **`release:provenance` manifests and CI artifacts:** none record a runtime tree digest. CI builds on Linux and could not produce the macOS `node_modules` tree in any case.

## Preventing a recurrence

A release can be the previous release of a later candidate on two paths. If it is pinned, it is checked against its pin, whatever its layout. If it is unpinned, it must pass the strict native verifier, so an unpinned pre-native tree is refused with an instruction to reproduce and pin it. Release IDs embed the source commit, so a release cannot pin itself. Pin a release in a reviewed change after it is installed, by running `release:reproduce` with `--compare` against the installed tree. Every later candidate built from that source can then roll back to it on an anchor that does not live on the host.

Residual risk, not closed by this change: unpinned *native-layout* previous releases still bind their digest from the install-time measurement in the snapshot, as on `main` before PR #26. Their per-asset native manifest is in-tree. Pinning each installed release closes this as releases age. Making the pin mandatory for every previous release is a deliberate future decision, because it would also govern historical C13 maintenance tooling.

The pin governs the retained *tree*. Restored LaunchAgent bodies are checked only for self-consistency: the exact label, a working directory inside the pinned release, and the hash recorded in the snapshot. Someone with the owner's uid can already write LaunchAgents directly, so this grants nothing new. It does mean the pin authenticates the runtime bytes, not the whole rollback transaction.

The tool refuses any commit that is not reachable from `origin/main`, before installing or building, because `npm ci` and the commit's builder execute that commit's code. Exit 0 means the build completed and no requested comparison failed. With an unpinned ID and no `--compare`, nothing was compared, and the receipt shows `pinned: null` and `compared: null`. Exit 1 means a comparison mismatched; exit 2 means the run was refused or failed.

The receipt the tool prints is labelled unsigned (`"signature": null`). It is a reproducible measurement, not an attestation, and no signing key was created or committed.
