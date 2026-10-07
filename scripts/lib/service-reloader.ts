import {
  errorText,
  failureOutcome,
  launchctlWithReconciliation,
  launchdIsAbsent,
  launchdIsRunning,
  launchdServiceIsEnabled,
  runLaunchctl,
  type LaunchctlRunner
} from './launchctl.js';

export type ReloadService = { label: string; target: string };
export type ReloadResult = {
  label: string;
  bootout: string;
  enable: string;
  bootstrap: string;
  kickstart: string;
  verified?: 'running' | 'exit-0';
  outcome?: 'failed' | 'ambiguous';
  error?: string;
};

export async function reloadLaunchdService(service: ReloadService, domain: string, runner: LaunchctlRunner = runLaunchctl): Promise<ReloadResult> {
  const result: ReloadResult = { label: service.label, bootout: 'pending', enable: 'pending', bootstrap: 'pending', kickstart: 'pending' };
  const target = `${domain}/${service.label}`;
  try {
    try {
      result.bootout = await launchctlWithReconciliation({
        args: ['bootout', domain, service.target], reconcileArgs: ['print', target],
        reconciled: () => false, reconciledError: launchdIsAbsent,
        expectation: 'service absent after bootout timeout', runner
      });
    } catch (error) {
      if (!launchdIsAbsent(error)) throw error;
      result.bootout = 'not-loaded';
    }

    result.enable = await launchctlWithReconciliation({
      args: ['enable', target], reconcileArgs: ['print-disabled', domain],
      reconciled: state => launchdServiceIsEnabled(state.stdout, service.label),
      expectation: 'service enabled after enable timeout', runner
    });

    result.bootstrap = await launchctlWithReconciliation({
      args: ['bootstrap', domain, service.target], reconcileArgs: ['print', target],
      reconciled: state => launchdIsRunning(state.stdout),
      expectation: 'service running after bootstrap timeout', runner
    });

    // A timed-out bootstrap that reconciles to running has already reached the required state.
    // Do not issue another start command after an uncertain lifecycle operation.
    if (result.bootstrap === 'reconciled') result.kickstart = 'skipped-running-after-timeout';
    else result.kickstart = await launchctlWithReconciliation({
      args: ['kickstart', target], reconcileArgs: ['print', target],
      reconciled: state => launchdIsRunning(state.stdout),
      expectation: 'service running after kickstart timeout', runner
    });
    return result;
  } catch (error) {
    result.error = errorText(error);
    result.outcome = failureOutcome(error);
    throw Object.assign(new Error(`${service.label}: ${result.error}`), { reloadResult: result });
  }
}
