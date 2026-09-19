import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARDWARE_NOT_AVAILABLE,
  PROOF_ENVIRONMENTS,
  PROOF_ITEMS,
  REQUIRED_PROOF_IDS,
  buildProofRun,
  describeProofRun,
  reconcileProofRun,
  requireProofItem,
  type EnvironmentAvailability,
  type ProofEnvironment,
  type ProofObservation
} from '../src/shared/proof-matrix.js';

function environments(overrides: Partial<Record<ProofEnvironment, EnvironmentAvailability>> = {}): Record<ProofEnvironment, EnvironmentAvailability> {
  const base = {} as Record<ProofEnvironment, EnvironmentAvailability>;
  for (const environment of PROOF_ENVIRONMENTS) base[environment] = { available: true, reason: 'present for this test' };
  return { ...base, ...overrides };
}

test('the proof matrix covers every required proof exactly once and states every limitation', () => {
  const ids = PROOF_ITEMS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'the matrix lists an id twice');
  for (const required of REQUIRED_PROOF_IDS) {
    const item = requireProofItem(required);
    assert.ok(item.limitation.trim().length > 20, `${required} has no meaningful limitation`);
    assert.ok(item.proves.trim().length > 20, `${required} does not say what it proves`);
    assert.ok((PROOF_ENVIRONMENTS as readonly string[]).includes(item.environment), `${required} names an unknown environment`);
  }
  assert.equal(REQUIRED_PROOF_IDS.length, 19, 'the required proof list is no longer the nineteen the brief names');
});

test('an item whose environment is absent is recorded unverified even when a pass is reported', () => {
  // The case that matters: a runner that believes it proved something it could not possibly have
  // proved here. Accepting its word is how a report comes to describe hardware nobody ever had.
  const observations: ProofObservation[] = [
    { id: 'android-adb-device', status: 'pass', detail: 'fabricated', observed: ['this should never survive'] }
  ];
  const results = reconcileProofRun(observations, environments({ 'android-device': { available: false, reason: 'no device attached' } }));
  const android = results.find(result => result.id === 'android-adb-device')!;
  assert.equal(android.status, 'unverified');
  assert.match(android.detail, new RegExp(HARDWARE_NOT_AVAILABLE));
  assert.match(android.detail, /no device attached/);
  // Not silently dropped either: a reader is told a result existed and was refused.
  assert.match(android.detail, /has been discarded/);
  assert.deepEqual(android.observed, [], 'evidence from an impossible proof survived into the report');
});

test('a failure reported for an absent environment is not recorded as a failure', () => {
  const results = reconcileProofRun(
    [{ id: 'android-adb-device', status: 'fail', detail: 'adb missing' }],
    environments({ 'android-device': { available: false, reason: 'no device attached' } })
  );
  const android = results.find(result => result.id === 'android-adb-device')!;
  // Absent hardware is not evidence that the feature is broken, and recording it red would teach a
  // reader to discount red lines on the day one of them is real.
  assert.equal(android.status, 'unverified');
});

test('an item that was never attempted is unverified and says so', () => {
  const results = reconcileProofRun([], environments());
  const item = results.find(result => result.id === 'kill-switch')!;
  assert.equal(item.status, 'unverified');
  assert.match(item.detail, /Not attempted in this run/);
  assert.match(item.detail, /not a passing one/);
  assert.doesNotMatch(item.detail, new RegExp(HARDWARE_NOT_AVAILABLE), 'an available environment was blamed on hardware');
});

test('an observation for an unknown item is an error rather than a discarded line', () => {
  assert.throws(
    () => reconcileProofRun([{ id: 'kill-swtich', status: 'pass', detail: 'typo' }], environments()),
    /unknown item: kill-swtich/
  );
  assert.throws(
    () => reconcileProofRun([
      { id: 'kill-switch', status: 'pass', detail: 'first' },
      { id: 'kill-switch', status: 'fail', detail: 'second' }
    ], environments()),
    /observed twice/
  );
});

test('a run is only declared physically proven when every required item passed here', () => {
  const everyRequired: ProofObservation[] = REQUIRED_PROOF_IDS.map(id => ({ id, status: 'pass', detail: 'observed' }));

  const partial = buildProofRun(everyRequired.slice(0, -1), environments());
  assert.ok(partial.summary.requiredUnproven.length > 0);
  assert.match(describeProofRun(partial).join('\n'), /NOT physically proven/);

  const complete = buildProofRun(everyRequired, environments());
  assert.deepEqual(complete.summary.requiredUnproven, []);
  assert.match(describeProofRun(complete).join('\n'), /Every required proof is established in this run/);

  // Supplementary items are not required, so they never hold back the verdict -- but they are still
  // counted and printed, so nobody mistakes the verdict for full coverage.
  assert.ok(complete.summary.unverified >= 0);
  assert.equal(complete.results.length, PROOF_ITEMS.length);
});

test('a required item that passes in an absent environment cannot satisfy the verdict', () => {
  const run = buildProofRun(
    REQUIRED_PROOF_IDS.map(id => ({ id, status: 'pass' as const, detail: 'observed' })),
    environments({ 'macos-host': { available: false, reason: 'this run is on linux' } })
  );
  assert.ok(run.summary.requiredUnproven.includes('fresh-node-install'));
  assert.match(describeProofRun(run).join('\n'), /NOT physically proven/);
});

test('a proof run carries no host identity', () => {
  const run = buildProofRun([], environments());
  assert.deepEqual(Object.keys(run.host).sort(), ['arch', 'node', 'platform', 'release']);
  assert.ok(!JSON.stringify(run.host).includes('hostname'));
});

test('a passing line always prints what it still does not establish', () => {
  const run = buildProofRun([{ id: 'kill-switch', status: 'pass', detail: 'observed' }], environments());
  const text = describeProofRun(run).join('\n');
  assert.match(text, /Still unproven: Stops future requests/);
});
