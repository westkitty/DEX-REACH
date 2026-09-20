import os from 'node:os';

/**
 * The catalog of physical and runtime proofs DEX//REACH must eventually carry, and the machinery
 * that stops a run from claiming one it did not perform.
 *
 * The problem this exists to solve is not "how do we test things". It is that a proof run reads as
 * authoritative. Someone who did not watch it will treat every green line as a fact about their
 * machine, so a line that was never executed -- or was executed somewhere that cannot establish the
 * claim -- is worse than no line at all. Every item therefore declares the one environment that can
 * establish it, and `reconcileProofRun` forces every other outcome to UNVERIFIED regardless of what
 * the runner reported.
 *
 * "Unverified" is a third outcome, not a soft failure. A missing Android device is not evidence
 * that ADB handling is broken, and recording it as a failure would eventually teach a reader to
 * ignore red lines. Recording it as a pass would be a lie. It gets its own word.
 */

export const PROOF_ENVIRONMENTS = [
  /** The running process, against the real modules with an isolated state directory. */
  'this-process',
  /** A real gateway and node agent, as separate OS processes, talking over a real socket. */
  'local-pair',
  /** A real macOS host with the service installed under launchd. */
  'macos-host',
  /** A real Android device reachable over ADB. */
  'android-device',
  /** A physically separate machine running its own node. */
  'second-machine'
] as const;

export type ProofEnvironment = (typeof PROOF_ENVIRONMENTS)[number];

export type ProofItem = {
  id: string;
  title: string;
  /** What a pass establishes, stated narrowly enough to be checkable. */
  proves: string;
  /** The only environment that can establish this item. */
  environment: ProofEnvironment;
  /** What a pass still does NOT establish. Mandatory: a proof without stated limits overclaims. */
  limitation: string;
};

/** The exact words an absent environment is recorded with, so a reader can grep for the gap. */
export const HARDWARE_NOT_AVAILABLE = 'UNVERIFIED — HARDWARE NOT AVAILABLE';

/**
 * The nineteen proofs the expansion brief requires before DEX//REACH may be called physically
 * proven. Listed separately from the catalog so that adding a supplementary item can never quietly
 * drop a required one; a test asserts the catalog covers every id here.
 */
export const REQUIRED_PROOF_IDS = [
  'fresh-node-install',
  'initial-access-off',
  'explicit-node-target',
  'asymmetric-enrollment',
  'identity-fingerprint',
  'read-only-mode',
  'mutation-refusal',
  'workspace-safe-profile',
  'typed-mutation',
  'arbitrary-shell-refusal',
  'temporary-grant',
  'rolling-budget-exhaustion',
  'machine-queue-admission',
  'kill-switch',
  'node-revocation',
  'node-re-enrollment',
  'execution-trace',
  'signed-receipt-chain',
  'evidence-export-verify'
] as const;

export const PROOF_ITEMS: readonly ProofItem[] = [
  {
    id: 'fresh-node-install',
    title: 'A node installs from nothing onto a real host',
    proves: 'The documented install path produces a running node service on a host that never had one, with its own credential file and 0600 key material.',
    environment: 'macos-host',
    limitation: 'Says nothing about upgrade-in-place, and nothing about any host other than the one it ran on.'
  },
  {
    id: 'initial-access-off',
    title: 'A newly enrolled node starts with AI access OFF',
    proves: 'A node with no policy file on disk resolves to OFF, a policy file that cannot be parsed resolves to OFF, and an initial-access setting that is not a recognised mode resolves to OFF rather than to anything that would admit work.',
    environment: 'this-process',
    limitation: 'Proves the starting state, not that the owner was ever shown how to change it.'
  },
  {
    id: 'explicit-node-target',
    title: 'Every request names one node, and an unknown node is refused',
    proves: 'The gateway routes only to the node id the caller named; an unknown or offline id is an error, never silently served by whichever node happens to be online.',
    environment: 'local-pair',
    limitation: 'Both nodes ran on one host, so this proves the routing rule, not that two physically separate machines stay distinct on the wire.'
  },
  {
    id: 'asymmetric-enrollment',
    title: 'A node authenticates to a live gateway with an Ed25519 proof',
    proves: 'A one-use enrollment token registers a node-held public key, the node connects by signing a transport proof, and after migration a bearer token no longer authenticates.',
    environment: 'local-pair',
    limitation: 'The private key was a 0600 file. No Keychain, Secure Enclave or TPM-backed store was exercised.'
  },
  {
    id: 'identity-fingerprint',
    title: 'The node reports an execution fingerprint of the real host',
    proves: 'The fingerprint is read from the running machine -- host, user, platform, interpreter versions, repository -- rather than from configuration a caller supplied.',
    environment: 'this-process',
    limitation: 'A fingerprint identifies where execution happened; it is not an attestation and can be forged by anyone who already controls the node.'
  },
  {
    id: 'read-only-mode',
    title: 'READ-ONLY admits inspection',
    proves: 'With the owner mode at READ-ONLY, inspection operations are served, so the mode is usable rather than a disguised OFF.',
    environment: 'this-process',
    limitation: 'Admission is not execution: this proves the policy decision, not the result of any inspection.'
  },
  {
    id: 'mutation-refusal',
    title: 'READ-ONLY refuses mutation through the whole path',
    proves: 'A write requested by a real MCP client against a real gateway is refused by the node itself while the owner mode is READ-ONLY, and the refusal names the node as the authority.',
    environment: 'local-pair',
    limitation: 'Proves refusal for the operations exercised, not that no future operation could be misclassified as inspection.'
  },
  {
    id: 'workspace-safe-profile',
    title: 'The workspace-safe profile refuses what it is supposed to refuse',
    proves: 'A real node process running workspace-safe admits typed writes and checkpoints through OAuth/MCP, refuses shell and process/session compatibility surfaces, and remains narrowed rather than widened when the owner switches to READ-ONLY.',
    environment: 'local-pair',
    limitation: 'Covers the operation and tool catalog as it stands on one host over loopback; it does not prove a deployed node or a newly added operation until that operation is classified and exercised.'
  },
  {
    id: 'typed-mutation',
    title: 'A typed mutation executes inside its declared roots',
    proves: 'A file write runs, lands inside an allowed root, and a write aimed outside the roots -- including by symlink -- is refused.',
    environment: 'this-process',
    limitation: 'Filesystem scope only. It says nothing about what the written content then does.'
  },
  {
    id: 'arbitrary-shell-refusal',
    title: 'Arbitrary shell is refused where it is not authorized',
    proves: 'Under read-only and workspace-safe, a shell command is refused at the node primitive itself, not merely at a higher layer that a different caller could bypass.',
    environment: 'this-process',
    limitation: 'Profiles that do admit shell admit real shell; nothing here makes those safe.'
  },
  {
    id: 'temporary-grant',
    title: 'A capability grant expires and exhausts',
    proves: 'A time-boxed, use-counted grant admits work while live, and is refused once its expiry passes or its uses are spent, with the refusal happening at reservation time.',
    environment: 'this-process',
    limitation: 'Proves the grant lifecycle, not that the owner understood what they granted.'
  },
  {
    id: 'rolling-budget-exhaustion',
    title: 'A rolling budget exhausts and refuses',
    proves: 'Authority cost accumulates in a rolling window, the ceiling refuses further work once reached, and budgets only ever narrow what policy already allowed.',
    environment: 'this-process',
    limitation: 'A budget bounds volume, not consequence: one admitted operation inside budget can still do serious damage.'
  },
  {
    id: 'machine-queue-admission',
    title: 'Machine admission holds across real processes',
    proves: 'Independent OS processes contending for a capacity ceiling admit exactly the ceiling and refuse the rest, so the queue is not an in-process illusion.',
    environment: 'this-process',
    limitation: 'Resource admission is not security authorization; being admitted grants no filesystem or process authority.'
  },
  {
    id: 'kill-switch',
    title: 'The owner kill switch stops work already in flight',
    proves: 'Flipping the owner mode to OFF on the node takes effect on the next request through the live path, with no gateway or client cooperation required.',
    environment: 'local-pair',
    limitation: 'Stops future requests. A command already running in a child process is not retroactively undone.'
  },
  {
    id: 'node-revocation',
    title: 'A revoked node is disconnected and stays out',
    proves: 'Revoking a node drops its live socket and refuses its reconnection attempts against a running gateway.',
    environment: 'local-pair',
    limitation: 'Revocation is enforced at the gateway. It does not reach into the node host to remove anything already there.'
  },
  {
    id: 'node-re-enrollment',
    title: 'A revoked node can be deliberately re-enrolled',
    proves: 'After an explicit forget, the same node id can enroll a fresh key and reconnect, and the old credential does not come back with it.',
    environment: 'local-pair',
    limitation: 'Recovery requires the owner to act; nothing here makes it automatic, and nothing should.'
  },
  {
    id: 'execution-trace',
    title: 'Execution produces a linked trace',
    proves: 'Spans are recorded for the stages of a request, share one trace id, and carry no command text, file content or arguments.',
    environment: 'this-process',
    limitation: 'A trace records that stages happened. It is not itself signed, so it is evidence of shape rather than of authenticity.'
  },
  {
    id: 'signed-receipt-chain',
    title: 'Receipts are signed and chained, and tampering breaks them',
    proves: 'Each receipt is signed by the node receipt key and names its predecessor, and editing any field or reordering the log fails verification.',
    environment: 'this-process',
    limitation: 'The chain proves nothing was altered after the fact. It cannot prove the node told the truth when it wrote the entry.'
  },
  {
    id: 'evidence-export-verify',
    title: 'An evidence bundle verifies offline',
    proves: 'A bundle exported from node-local evidence verifies with no access to the node, carries no content, and answers each claim separately instead of one overall verdict.',
    environment: 'this-process',
    limitation: 'Offline verification establishes internal consistency and signature validity. It cannot establish that the signing node is the machine anyone believes it to be.'
  },
  // Supplementary items. Not among the required nineteen, but present so the matrix names these
  // gaps explicitly. An absent line reads as "fine" to everyone who was not in the room.
  {
    id: 'live-mcp-surface',
    title: 'A real MCP client sees exactly the contracted surface on a running gateway',
    proves: 'An OAuth/PKCE client of the current MCP SDK lists exactly the intended first-class actions against a running gateway, sees exactly the approved compatibility tool surface for a node with the withheld tools absent rather than refused, and receives a trust report that scopes its own verdict to the checks it ran.',
    environment: 'local-pair',
    limitation: 'The gateway ran over loopback HTTP. This is not the deployed HTTPS ingress, and the client was the SDK rather than ChatGPT or Claude, so the marks waiting on a deployed smoke are not cleared by it.'
  },
  {
    id: 'android-adb-device',
    title: 'ADB operations run against a real Android device',
    proves: 'The android-adb profile enumerates and acts on a physically attached device.',
    environment: 'android-device',
    limitation: 'Device-specific. One phone proves one phone.'
  },
  {
    id: 'second-physical-machine',
    title: 'Two physically separate machines stay distinct',
    proves: 'A node on a second physical machine enrolls independently, and a request naming one machine never executes on the other.',
    environment: 'second-machine',
    limitation: 'Proves separation for the pair that ran; it is not a statement about scale.'
  }
];

export function proofItem(id: string): ProofItem | undefined {
  return PROOF_ITEMS.find(item => item.id === id);
}

export function requireProofItem(id: string): ProofItem {
  const item = proofItem(id);
  if (!item) throw new Error(`unknown proof item: ${id}`);
  return item;
}

export type ProofStatus = 'pass' | 'fail' | 'unverified';

/** What a runner reports for an item it actually executed. It cannot report `unverified`. */
export type ProofObservation = {
  id: string;
  status: 'pass' | 'fail';
  detail: string;
  /** Verbatim lines the runner saw -- refusal messages, counts, hashes. Evidence, not narration. */
  observed?: string[];
};

export type ProofResult = ProofItem & {
  status: ProofStatus;
  detail: string;
  observed: string[];
};

export type EnvironmentAvailability = {
  available: boolean;
  /** Why it is or is not available. Required either way, so a reader never has to guess. */
  reason: string;
};

export type ProofRun = {
  version: 1;
  at: string;
  /** Deliberately no hostname: a proof run is routinely pasted into a report. */
  host: { platform: string; arch: string; release: string; node: string };
  environments: Record<ProofEnvironment, EnvironmentAvailability>;
  results: ProofResult[];
  summary: { pass: number; fail: number; unverified: number; requiredUnproven: string[] };
};

export function hostSummary(): ProofRun['host'] {
  return { platform: process.platform, arch: process.arch, release: os.release(), node: process.version };
}

/**
 * Turn what a runner observed into what may honestly be recorded.
 *
 * This is the only place a proof result is allowed to come into existence, and it deliberately does
 * not trust its caller. An observation for an environment that was not available is discarded and
 * said to have been discarded -- not silently dropped, because a silent drop is indistinguishable
 * from a proof that was never written, and not accepted, because the runner having produced a line
 * is not evidence that the hardware was there.
 */
export function reconcileProofRun(
  observations: readonly ProofObservation[],
  environments: Record<ProofEnvironment, EnvironmentAvailability>,
  items: readonly ProofItem[] = PROOF_ITEMS
): ProofResult[] {
  const byId = new Map(items.map(item => [item.id, item]));
  for (const observation of observations) {
    // A typo in a runner would otherwise vanish: the item stays "not attempted" and nobody learns
    // that a proof which did run was thrown away.
    if (!byId.has(observation.id)) throw new Error(`proof observation for unknown item: ${observation.id}`);
  }
  const seen = new Set<string>();
  for (const observation of observations) {
    if (seen.has(observation.id)) throw new Error(`proof item observed twice: ${observation.id}`);
    seen.add(observation.id);
  }

  return items.map(item => {
    const environment = environments[item.environment];
    const observation = observations.find(entry => entry.id === item.id);
    if (!environment.available) {
      const discarded = observation
        ? ` A result was reported for this item and has been discarded, because this run had no ${item.environment} to establish it.`
        : '';
      return {
        ...item,
        status: 'unverified',
        detail: `${HARDWARE_NOT_AVAILABLE}: ${environment.reason}.${discarded}`,
        observed: []
      };
    }
    if (!observation) {
      return {
        ...item,
        status: 'unverified',
        detail: `Not attempted in this run, although a ${item.environment} was available. This is an absent proof, not a passing one.`,
        observed: []
      };
    }
    return { ...item, status: observation.status, detail: observation.detail, observed: observation.observed ?? [] };
  });
}

export function buildProofRun(
  observations: readonly ProofObservation[],
  environments: Record<ProofEnvironment, EnvironmentAvailability>,
  items: readonly ProofItem[] = PROOF_ITEMS
): ProofRun {
  const results = reconcileProofRun(observations, environments, items);
  const proven = new Set(results.filter(result => result.status === 'pass').map(result => result.id));
  return {
    version: 1,
    at: new Date().toISOString(),
    host: hostSummary(),
    environments,
    results,
    summary: {
      pass: results.filter(result => result.status === 'pass').length,
      fail: results.filter(result => result.status === 'fail').length,
      unverified: results.filter(result => result.status === 'unverified').length,
      // Walked over the required list rather than over the results, so a required item that is
      // missing from `items` entirely counts as unproven. Filtering the results would have let a
      // narrowed catalog report "every required proof is established" while silently covering
      // fewer of them -- the exact shape of overclaim this module exists to prevent.
      requiredUnproven: REQUIRED_PROOF_IDS.filter(id => !proven.has(id))
    }
  };
}

const MARK: Record<ProofStatus, string> = { pass: 'PROVEN  ', fail: 'FAILED  ', unverified: 'UNVERIF.' };

export function describeProofRun(run: ProofRun): string[] {
  const lines = [
    `DEX//REACH proof run ${run.at}`,
    `Host: ${run.host.platform}/${run.host.arch} ${run.host.release}, Node ${run.host.node}`,
    ''
  ];
  for (const environment of PROOF_ENVIRONMENTS) {
    // A run read back from a file is untyped data, and a missing entry must read as an absence
    // rather than crash the reader halfway through a report.
    const state = run.environments[environment] as EnvironmentAvailability | undefined;
    lines.push(`  ${environment.padEnd(15)} ${state?.available ? 'available' : 'not available'} — ${state?.reason ?? 'this run recorded nothing about this environment'}`);
  }
  lines.push('');
  for (const result of run.results) {
    lines.push(`${MARK[result.status]}  ${result.id}`);
    lines.push(`          ${result.title}`);
    lines.push(`          ${result.detail}`);
    for (const line of result.observed) lines.push(`          · ${line}`);
    if (result.status === 'pass') lines.push(`          Still unproven: ${result.limitation}`);
    lines.push('');
  }
  lines.push(`${run.summary.pass} proven, ${run.summary.fail} failed, ${run.summary.unverified} unverified.`);
  lines.push(run.summary.requiredUnproven.length
    ? `Required proofs still unproven: ${run.summary.requiredUnproven.join(', ')}. DEX//REACH is NOT physically proven.`
    : 'Every required proof is established in this run.');
  return lines;
}
