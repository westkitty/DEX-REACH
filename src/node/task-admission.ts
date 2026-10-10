import { coordinatedAcquire, coordinatedCancel, coordinatedRelease } from '../coordinator/client.js';
import type { WorkRequest } from '../shared/work-coordinator.js';
import { MAX_ADMISSION_MS } from '../shared/request-deadlines.js';
const defaults = {
 acquire: coordinatedAcquire, cancel: coordinatedCancel, release: coordinatedRelease,
 now: () => performance.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.min(250, Number.isFinite(ms) ? ms : 0))))
};
/** Do not race acquisition against a client timer: a late acquired lease must be accounted for. */
export async function acquireTaskAdmission(request: WorkRequest, status: (text: string) => Promise<void>, deadline: number, hooks = defaults): Promise<string> {
 let ticketId: string | undefined;
 let lastReason = 'coordinator admission is pending';
 const absoluteCeiling = hooks.now() + MAX_ADMISSION_MS;
 deadline = Math.min(deadline, absoluteCeiling);
 try {
  for (;;) {
   if (hooks.now() >= deadline) throw new Error(`COORDINATOR_WAIT_TIMEOUT: ${lastReason}`);
   const admission = await hooks.acquire({...request,...(ticketId ? {ticketId} : {})});
   if (admission.status === 'acquired') {
    if (hooks.now() >= deadline) {
     const released = await hooks.release(admission.lease.id);
     if (!released.released) throw new Error('COORDINATOR_LATE_LEASE_RELEASE_UNCONFIRMED: execution never started');
     throw new Error(`COORDINATOR_WAIT_TIMEOUT: admission arrived after deadline`);
    }
    return admission.lease.id;
   }
   ticketId = admission.ticket.id;
   lastReason = admission.reasons.join('; ') || `position ${admission.position}`;
   await status(`WAITING_FOR_COORDINATOR: ${lastReason}`);
   const remaining = deadline - hooks.now();
   if (remaining <= 0) throw new Error(`COORDINATOR_WAIT_TIMEOUT: ${lastReason}`);
   await hooks.sleep(Math.min(250, remaining));
  }
 } catch (error) {
  if (ticketId) await hooks.cancel(ticketId); // Failure is visible; never claim successful cleanup without readback.
  throw error;
 }
}
