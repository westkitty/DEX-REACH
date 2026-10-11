# C13 E4 — real ChatGPT host proof after installed worker repair

Evidence date (UTC): 2026-10-08.
Evidence source: actual owner MacBook terminal output and ChatGPT's live DEX//REACH Refresh connector calls. This file is a bounded operational receipt, not evidence of C13 closure.

## Immutable installation (owner terminal)
- Repair worktree: `/Users/andrew/dex-reach-c13-worker-repair`, branch `c13-worker-repair`, base `175d58b8cce5`, dirty/uncommitted.
- Source repair: fingerprint worker IPC deadline increased from 5,000 ms to 21,000 ms; other operation deadlines unchanged.
- `npm run verify`: typecheck PASS; 42 invariant checks PASS; 331 full native tests PASS (0 failed); build PASS; production audit had six moderate advisories but no audit-level high failure; backend probe exposed 26 local tools.
- Installer staged release `0.3.2-175d58b8cce5-2f44ae46b11b-dirty-1791501412637`.
- Owner-local installer verification returned `IMMUTABLE_INSTALL_VERIFIED`, state `complete`, and coordinator/worker/gateway/node services running.
- Existing task identities, worker roots/configuration, and previous immutable release were reported preserved. Backup was recorded under the owner-private recovery directory.
- These are installation/verification observations, not source publication.

## Actual ChatGPT MCP E4 proof
- Connector inventory: exactly 17 public tools.
- Explicit target: `node_id=macbook-air.local`; no other node selected.
- New task started once via `reach_task(start, operation=dex.fingerprint, mode=durable, cwd=/Users/andrew/dex-reach-c13-worker-repair)`.
- Task ID: `rtsk_1a11dd2033f_bafe187416836f1b920ed7d2d4f9fc79`.
- Start returned `RUNNING` and `durable:true`.
- Same-task `reach_task(get)` returned `COMPLETED`, attempt 1, safety `PURE_READ_IDEMPOTENT`, mutation `NONE`, persisted result reference and hash present.
- Same-task `reach_task(result)` succeeded, returning node `macbook-air.local`, hostname `MacBook-Air.local`, user `andrew`, platform `darwin`, architecture `arm64`, working tree and repository root `/Users/andrew/dex-reach-c13-worker-repair`, branch `c13-worker-repair`.
- Ordinary direct `reach_fingerprint` on the same node also succeeded with expected machine identity; this action type timed out on the prior installed runtime.
- No approval dialog was observed for these calls (not a claim that future calls need no approval).
- The original failed E4 task `rtsk_1a11d617415_14783ad15e0b76b8c9dfcea35080814e` remains `FAILED / EXECUTION_FAILED`; it was not retried or overwritten.
- Post-smoke node inventory: online, access on, four DEX services, queue depth 0, active leases 0; scoped `reach_trust_report` verdict PASS.

## Gates and unresolved scope
- E4: PASS for fresh installed real-host read-only durable execution, same-task retrieval and direct fingerprint.
- E1/E2/E6: PASS per prior C13 evidence. E5: accepted UNDECIDABLE-FROM-LOGS.
- E3: reviewed private Site fixture/stale labels authorized for publication but publication has NOT been observed.
- E7: PARTIAL; no owner-controlled connector disable/re-enable while a genuinely RUNNING same task has been demonstrated.
- C13: NOT PASS. C14: preparation only. C15: untouched.
- Git: repair branch remains dirty/uncommitted/unpushed; no merge or source publication performed.
- Historical PREPARING/RUNNING task states and AMBIGUOUS_EFFECT evidence were preserved; no blind replay, state reset, or destructive task reconciliation.

Do not present scoped trust PASS or this E4 success as the full C13 acceptance gate.
