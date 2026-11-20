# C14 active-runtime identity rebaseline guard (source-only, 2026-11-20)

## Evidence

- Source base: westkitty/DEX-REACH main at 555befc50c35169878abcd325c0186c83800626f. Exact-main DEX validation push run 44243204624 and CodeQL push run 44243204652 succeeded; those are PRE-CHANGE results, not proof of this branch.
- The live macbook-air.local node and scoped trust report identify the installed immutable runtime as 0.4.0-f7f59b35ebcd-191f252a5681. That trust report checks identity, policy, roots and transport. It does NOT measure the full runtime tree, native rollback journal, live five-service identities or backup durability.
- The reviewed TRUSTED_RUNTIME_RELEASES in scripts/lib/runtime-rollback.ts pins C13 0.3.2-87a99494ebb3-2f44ae46b11b and historical 0.4.0-274ba16e058e-2d5b454853af. It does NOT pin the active f7f59b35 release. No digest, authoritative transaction, owner approval or restore result is inferred from its name.
- The prior scripts/c14-recovery.ts preflight independently hashed the retained C13 directory and set installedRelease = RETAINED_RELEASE even if the five active launchd routes ran a different release. The FIVE_SERVICES gate separately failed, but the INSTALLED_IDENTITY report could be incorrectly positive.

## Source-only correction

1. Parse the exact working-directory release ID of each of the five launchd services. Accept a release identity only when all five agree and use the immutable version/commit/lock format; refuse mixed, malformed, duplicated or non-release paths.
2. Find that observed live ID in the immutable reviewed runtime pin registry. Hash only its actual directory when a reviewed source/tree pin exists. Do not trust a historical retained directory as installed proof, a snapshot-provided digest, or an unpinned current runtime.
3. Check installed identity against the five observed routes and complete reviewed tree digest; report the observed ID and whether a pin exists. Never emit private file contents.
4. Preserve the exact historical C13 source SHA, complete-tree digest, transaction, journal, capture and legacy rollback constraints. No gate is removed or renamed; no source tests are weakened.

## Remaining hard stop

This change deliberately does not authorize or finish a current-0.4.0 release-contract migration. The active f7f59b35 tree lacks an independently authenticated source/tree digest, so INSTALLED_IDENTITY and RECOVERY_BASELINE must remain blocked. C14's v1 owner-window authorization has a C13-specific retainC13 decision, not approval to treat the current 0.4.0 deployment as Last Known Good. Existing C13 preservation must not be displaced.

Further independent proof and owner decisions are necessary before a separate reviewed rebaseline: obtain exact full source/lock identity; rebuild and byte-compare the installed tree using a permitted read-only provenance procedure; add a reviewed immutable pin only from that proof; define a versioned owner approval and rollback/capture contract for the observed current release; verify the historical C13 fallback independently. A missing/denied owner-private read cannot be bypassed to manufacture proof.

No code from this branch is installed. Exact-branch GitHub PR validation and CodeQL remain required; source appearance does not certify a runtime. The current C14 30/30 preflight, certified encrypted capture and isolated real restore, owner-approved maintenance window, installed interrupt/reconcile, rollback-forward transaction and C15 acceptance remain NO-GO/BLOCKED.

## Protected surfaces

Original dirty checkout, two existing recovery/release worktrees, installed node/gateway/coordinator/worker/Control Room, policies, secrets, iCloud, historical task/quarantine state, archived releases, and all user data remain untouched. This file grants no maintenance, installation, backup, deletion or physical-chaos authority.
