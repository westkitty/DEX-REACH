# C15 release-readiness preparation

## Status

**BLOCKED.** C15 has not started. C14-K passes within source scope, but C14 program acceptance is not established; release, installation, deployment, connector refresh, and human acceptance still require explicit owner authority.

## Conditions before C15 execution

1. Close every C14 program exit requirement, including physical/installed boundaries that cannot be proven by source tests alone.
2. Resolve the ADR-0003 v1/v2 migration decision or formally bound the release to the current Protocol v1 capability contract.
3. Obtain exact release version and source-SHA authority.
4. Run the repository-native validation and dependency audit on the frozen release candidate.
5. Prove clean-build and provenance artifacts from the exact release commit.
6. Execute the immutable macOS installation sequence only during an owner-authorized maintenance window.
7. Prove rollback readiness and preservation of the previous installed release.
8. Revalidate installed service identity, health, task lifecycle, coordinator cleanup, and owner policy.
9. Perform public MCP connector/tool-snapshot verification through the owning system; source tests do not refresh a connector.
10. Perform local Control Room visual/functional acceptance and any authorized ChatGPT Site/Space checks.
11. Run required DEX ecosystem conformance tests for PAIR PRIVATE/SEALED, DROPZONE, WITNESS, and the 50-command roster, or record their exact unverified boundaries.
12. Preserve C13/E7 distinctions and retain failed/ambiguous historical evidence.

## Candidate packet checklist

| Item | State | Evidence needed |
| --- | --- | --- |
| C14 program status | PARTIAL / NOT COMPLETE | C14-K source matrix; installed, physical, ecosystem, migration, and human gates remain |
| Release version and SHA | UNKNOWN | Owner-approved release candidate |
| CI and audit | PARTIAL | Audit exited 0 with six moderate advisories; exact-head hosted checks remain UNKNOWN |
| Clean build/provenance | PARTIAL | Source clean-build exists; release provenance still required |
| Immutable install/rollback | BLOCKED | Owner maintenance authority and fresh installed proof |
| Public connector | BLOCKED | Owning connector refresh and real-client acceptance |
| Control Room acceptance | UNVERIFIED | Direct visual and functional acceptance |
| Ecosystem conformance | UNVERIFIED | Authoritative DEX fixtures/runtime |

No installer, service restart, deployment, connector refresh, credential rotation, merge, or release tag was performed while preparing this document.
