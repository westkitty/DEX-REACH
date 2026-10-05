import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall, decideBootRecovery } from '../src/shared/task-recovery.js';

const now = Date.now();
const recent = new Date(now - 1_000).toISOString();
const old = new Date(now - 300_000).toISOString();

test('stall classification keeps independent liveness signals distinct', () => {
  const base = {
    state: 'RUNNING' as const,
    nowMs: now,
    taskHeartbeatAt: recent,
    stateTransitionAt: recent,
    processAlive: true,
    transportConnected: true,
    waitingExternal: false,
    cpuActive: false
  };
  assert.equal(classifyStall({ ...base, processAlive: false }), 'process-gone');
  assert.equal(classifyStall({ ...base, transportConnected: false }), 'transport-lost');
  assert.equal(classifyStall({ ...base, waitingExternal: true }), 'waiting-external');
  assert.equal(classifyStall({ ...base, cpuActive: true }), 'cpu-active');
  assert.equal(classifyStall({ ...base, taskHeartbeatAt: old, stateTransitionAt: old }), 'no-progress');
  assert.equal(classifyStall({ ...base, taskHeartbeatAt: old, stateTransitionAt: recent }), 'quiet-but-alive');
});

test('boot recovery finishes only verified results and never replays uncertain effects', () => {
  assert.equal(decideBootRecovery({
    state: 'RUNNING', safetyClass: 'PROCESS_UNKNOWN_EFFECT', hasDurableResult: true,
    hasMatchingLiveActivity: false, hasMatchingLease: false, processAlive: false,
    hasMatchingQueueTicket: false,
    transportConnected: true, contradictoryEvidence: false
  }).kind, 'FINISH_FROM_DURABLE_EVIDENCE');
  assert.equal(decideBootRecovery({
    state: 'RUNNING', safetyClass: 'PROCESS_UNKNOWN_EFFECT', hasDurableResult: false,
    hasMatchingLiveActivity: true, hasMatchingLease: true, processAlive: true,
    hasMatchingQueueTicket: false,
    transportConnected: true, contradictoryEvidence: false
  }).kind, 'REATTACH');
  assert.equal(decideBootRecovery({
    state: 'RUNNING', safetyClass: 'PROCESS_UNKNOWN_EFFECT', hasDurableResult: false,
    hasMatchingLiveActivity: false, hasMatchingLease: false, processAlive: false,
    hasMatchingQueueTicket: false,
    transportConnected: true, contradictoryEvidence: false
  }).kind, 'AMBIGUOUS');
  assert.equal(decideBootRecovery({
    state: 'PREPARING', safetyClass: 'SIDE_EFFECTING_IDEMPOTENT', hasDurableResult: false,
    hasMatchingLiveActivity: false, hasMatchingLease: false, processAlive: false,
    hasMatchingQueueTicket: false,
    transportConnected: true, contradictoryEvidence: false
  }).kind, 'RETRY_SAFE');
  assert.equal(decideBootRecovery({
    state: 'RUNNING', safetyClass: 'PROCESS_UNKNOWN_EFFECT', hasDurableResult: false,
    hasMatchingLiveActivity: true, hasMatchingLease: false, processAlive: true,
    hasMatchingQueueTicket: false,
    transportConnected: true, contradictoryEvidence: true
  }).kind, 'DEGRADED');
});
