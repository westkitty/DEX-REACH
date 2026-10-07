import test from 'node:test';
import assert from 'node:assert/strict';
import {
  launchctlWithReconciliation,
  launchdIsRunning,
  launchdServiceIsEnabled,
  type LaunchctlResult,
  type LaunchctlRunner
} from '../scripts/lib/launchctl.js';
import { reloadLaunchdService } from '../scripts/lib/service-reloader.js';

const timeout = Object.assign(new Error('launchctl timed out'), { code: 'ETIMEDOUT' });
const service = { label: 'com.example.coordinator', target: '/tmp/com.example.coordinator.plist' };

test('kickstart timeout reconciles a running service without replaying the restart', async () => {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async args => {
    calls.push(args);
    if (args[0] === 'kickstart') throw timeout;
    if (args[0] === 'print') return { stdout: 'state = running\n pid = 42\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const result = await reloadLaunchdService(service, 'gui/501', runner);
  assert.equal(result.kickstart, 'reconciled');
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'enable', 'bootstrap', 'kickstart', 'print']);
});

test('bootstrap timeout that proves the service is running skips kickstart', async () => {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async args => {
    calls.push(args);
    if (args[0] === 'bootstrap') throw timeout;
    if (args[0] === 'print') return { stdout: 'state = running\n pid = 43\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const result = await reloadLaunchdService(service, 'gui/501', runner);
  assert.equal(result.bootstrap, 'reconciled');
  assert.equal(result.kickstart, 'skipped-running-after-timeout');
  assert.equal(calls.some(args => args[0] === 'kickstart'), false);
});

test('bootout timeout reconciles an absent service without replaying bootout', async () => {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async args => {
    calls.push(args);
    if (args[0] === 'bootout') throw timeout;
    if (args[0] === 'print') throw Object.assign(new Error('launchctl exit 113'), { stderr: 'Could not find service "com.example.coordinator" in domain' });
    return { stdout: '', stderr: '' };
  };
  const result = await reloadLaunchdService(service, 'gui/501', runner);
  assert.equal(result.bootout, 'reconciled');
  assert.equal(calls.filter(args => args[0] === 'bootout').length, 1);
  assert.deepEqual(calls.slice(0, 2).map(args => args[0]), ['bootout', 'print']);
});

test('timeout without a running service yields a bounded failure', async () => {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async args => {
    calls.push(args);
    if (args[0] === 'kickstart') throw timeout;
    if (args[0] === 'print') return { stdout: 'state = spawn scheduled\nlast exit code = 78\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  let failure: (Error & { reloadResult?: { outcome?: string } }) | undefined;
  await reloadLaunchdService(service, 'gui/501', runner).catch(error => { failure = error as Error & { reloadResult?: { outcome?: string } }; });
  assert.match(failure?.message || '', /expected service running after kickstart timeout was not proven/);
  assert.equal(failure?.reloadResult?.outcome, 'ambiguous');
  assert.equal(calls.filter(args => args[0] === 'kickstart').length, 1);
});

test('timeout with failed reconciliation remains ambiguous and bounded', async () => {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async args => {
    calls.push(args);
    throw Object.assign(new Error('launchctl timed out'), { code: 'ETIMEDOUT' });
  };
  await assert.rejects(launchctlWithReconciliation({
    args: ['kickstart', 'gui/501/com.example.coordinator'], reconcileArgs: ['print', 'gui/501/com.example.coordinator'],
    reconciled: state => launchdIsRunning(state.stdout), expectation: 'service running', runner
  }), /outcome ambiguous because reconciliation failed/);
  assert.deepEqual(calls.map(args => args[0]), ['kickstart', 'print']);
});

test('enable timeout reconciles only when print-disabled confirms enabled', async () => {
  assert.equal(launchdServiceIsEnabled('"com.example.coordinator" => enabled', service.label), true);
  assert.equal(launchdServiceIsEnabled('"com.example.coordinator" => disabled', service.label), false);
  let calls = 0;
  const runner: LaunchctlRunner = async args => {
    calls += 1;
    if (args[0] === 'enable') throw timeout;
    return { stdout: '"com.example.coordinator" => enabled', stderr: '' } satisfies LaunchctlResult;
  };
  assert.equal(await launchctlWithReconciliation({
    args: ['enable', 'gui/501/com.example.coordinator'], reconcileArgs: ['print-disabled', 'gui/501'],
    reconciled: state => launchdServiceIsEnabled(state.stdout, service.label),
    expectation: 'service enabled', runner
  }), 'reconciled');
  assert.equal(calls, 2);
});
