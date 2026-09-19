import { reserveBudgetUsage } from '../../src/shared/budget-usage.js';
import { acquireWork, type CapacitySnapshot } from '../../src/shared/work-coordinator.js';
import type { ClientKind } from '../../src/shared/protocol.js';
import type { AccessClass, WorkloadClass } from '../../src/shared/machine-capacity.js';

/**
 * One contender in a concurrency proof, running as its own OS process.
 *
 * A ceiling that holds inside one process proves almost nothing: promises in a single event loop
 * share every in-memory guard, so the interesting failure -- two processes each reading the state
 * file, each deciding there is room, each writing -- cannot occur. This worker exists so that
 * failure has the chance to occur and is observed not to.
 *
 * It deliberately does not release what it reserved. It holds until the caller closes its stdin,
 * because a slot released mid-run would be handed to a later contender and the count would come
 * out right for the wrong reason -- and a fixed sleep is no better, since on a loaded machine the
 * first worker can exit before the last one has started. The caller owns the whole temporary state
 * directory and discards it afterwards.
 */

type BudgetJob = {
  mode: 'budget-slot';
  stateDir: string;
  nodeId: string;
  client: ClientKind;
};

type WorkJob = {
  mode: 'work-acquire';
  stateDir: string;
  repositoryRoot: string;
  access: AccessClass;
  workload: WorkloadClass;
  snapshot: CapacitySnapshot;
};

type Job = BudgetJob | WorkJob;

/**
 * Hold the reservation until the caller releases it, or until a backstop expires.
 *
 * The backstop exists so a worker can never outlive a caller that died: an orphan holding a slot in
 * a temporary state directory is harmless, but an orphan holding one forever is a leaked process.
 */
function holdUntilReleased(): Promise<void> {
  return new Promise(resolve => {
    const backstop = setTimeout(resolve, 5 * 60_000);
    const done = () => { clearTimeout(backstop); resolve(); };
    process.stdin.resume();
    process.stdin.once('end', done);
    process.stdin.once('close', done);
    process.stdin.once('error', done);
    process.once('SIGTERM', done);
  });
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error('proof worker requires a job as its single argument');
  const job = JSON.parse(raw) as Job;
  process.env.DEX_REACH_STATE_DIR = job.stateDir;

  if (job.mode === 'budget-slot') {
    const result = await reserveBudgetUsage(job.nodeId, job.client, {
      operations: 1, mutations: 0, shellCalls: 0, requestedWriteBytes: 0, requestedProcessMs: 0
    }, { dir: job.stateDir });
    report({ pid: process.pid, outcome: result.allowed ? 'admitted' : 'refused', detail: result.allowed ? '' : result.reason });
    await holdUntilReleased();
    return;
  }

  const result = await acquireWork({
    executor: 'claude-code',
    access: job.access,
    workload: job.workload,
    repositoryRoot: job.repositoryRoot,
    phase: 'proof',
    snapshot: job.snapshot
  });
  report({
    pid: process.pid,
    outcome: result.status === 'acquired' ? 'admitted' : 'refused',
    detail: result.status === 'acquired' ? result.lease.id : result.reasons.join('; ')
  });
  await holdUntilReleased();
}

/** One JSON line on stdout, written synchronously so an exit cannot lose it. */
function report(value: { pid: number; outcome: 'admitted' | 'refused'; detail: string }): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ pid: process.pid, outcome: 'error', detail: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exitCode = 1;
});
