# C14-G source recovery runbook

This runbook is for isolated source reconstruction. It does not install, deploy, restart, or connect to the owner runtime.

```sh
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git rev-parse origin/c14-chaos-recovery
git status --short

RECOVERY_WORKTREE="$(mktemp -d /tmp/dex-c14-recovery.XXXXXX)"
git worktree add --detach "$RECOVERY_WORKTREE" HEAD
cd "$RECOVERY_WORKTREE"
npm ci
npm run typecheck
npm run invariants -- --check
npm run build
node --test --import tsx tests/c14-mixed-version.test.ts
npm run verify:clean-build
```

For durable fixtures, set `DEX_REACH_STATE_DIR` before importing or starting the fixture and assert every task, result, event, lease, queue, and coordinator history path remains beneath the temporary root. Do not use owner credentials or installed endpoints. Remove only the exact disposable worktree after the report is committed.
