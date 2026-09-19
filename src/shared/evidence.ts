import crypto from 'node:crypto';
import { canonicalJson, hashValue } from './hash.js';
import { listReceipts, verifyReceipt, type ExecutionReceipt } from './receipts.js';
import { isValidTraceId, readTrace, sanitizeSpan, type TraceSpan } from './trace.js';

/**
 * Portable, privacy-preserving evidence bundles.
 *
 * A bundle is a self-contained JSON document that a third party can check offline, without the node,
 * without network access and without DEX installed beyond this verifier. It carries identifiers,
 * hashes, signed receipts and sanitized trace spans. It deliberately carries no file content, no
 * stdout or stderr, no credentials, no private keys, no secret values, no raw owner policy and no
 * raw plan arguments.
 *
 * The hard design rule is that verification never produces a single VERIFIED. Different facts in a
 * bundle are provable to very different degrees, and collapsing them into one word is how evidence
 * gets over-read. The verifier therefore answers each claim separately and says, in the same
 * breath, what each answer does not mean:
 *
 *   - Signatures verify against the public key the bundle itself carries. That proves internal
 *     consistency. It does not prove the bundle came from a particular node, because a forger with
 *     their own key can produce an internally perfect bundle. Binding a bundle to a node means
 *     comparing its key fingerprint against one the verifier already trusts, which is an act only
 *     the verifier can perform.
 *   - A chain that is contiguous within the bundle is not a complete chain. Receipts can be omitted
 *     at either end without leaving a gap, so completeness is reported as unproven rather than
 *     inferred from the absence of a break.
 *   - A signed receipt records what the node was asked to do and what it reported. It is not proof
 *     that the world changed. That distinction is the whole reason the "external side effect" claim
 *     exists and always reads NOT PROVEN.
 */

export const EVIDENCE_BUNDLE_VERSION = 1;

export type EvidenceClaimStatus = 'pass' | 'fail' | 'not-included' | 'not-proven';

export type EvidenceClaim = {
  claim: string;
  status: EvidenceClaimStatus;
  /** What the status means, and where relevant what it does not mean. Never optional. */
  detail: string;
};

/**
 * An optional, deliberate disclosure by the bundle's author.
 *
 * A request hash alone proves nothing to a third party: they cannot recompute it without the
 * arguments, and the arguments are exactly what a privacy-preserving bundle withholds. When the
 * author is willing to state what was run, they attach it here and the verifier recomputes the hash
 * and compares. This is opt-in and off by default, because attaching it publishes the arguments.
 */
export type EvidenceDisclosure = {
  receiptId: string;
  operation: string;
  args: Record<string, unknown>;
};

export type EvidenceBundle = {
  version: typeof EVIDENCE_BUNDLE_VERSION;
  bundleId: string;
  createdAt: string;
  nodeId: string;
  /** SPKI PEM. Public by construction; the matching private key never leaves the node. */
  receiptPublicKey: string;
  /** SHA-256 of the PEM, for comparing against a key the verifier already trusts. */
  receiptPublicKeyFingerprint: string;
  traceId: string | null;
  receipts: ExecutionReceipt[];
  spans: TraceSpan[];
  disclosures: EvidenceDisclosure[];
  /** Stated in the bundle so a reader who never runs the verifier still sees them. */
  limitations: string[];
  /** Canonical hash of everything above. A checksum against accidental damage, not a signature. */
  bundleHash: string;
};

export type EvidenceVerification = {
  bundleId: string | null;
  nodeId: string | null;
  receiptPublicKeyFingerprint: string | null;
  claims: EvidenceClaim[];
  /** Counts by status. Deliberately not a verdict. */
  summary: { pass: number; fail: number; notIncluded: number; notProven: number };
};

const LIMITATIONS: readonly string[] = [
  'Signatures verify against the public key carried in this bundle. That proves the bundle is internally consistent; it does not prove which node produced it. Compare the key fingerprint against a key you already trust.',
  'A bundle may contain a slice of a node\'s receipt chain. Receipts omitted at either end leave no gap, so this bundle cannot prove it is complete.',
  'A signed receipt records what the node was asked to do and what it reported. It is not evidence that a file, a repository or a remote system actually changed.',
  'Execution output, file contents, raw request arguments and raw owner policy are excluded by design. Their hashes are present; the values are not.',
  'A checkpoint identifier is recorded. The checkpoint contents are not in this bundle, and the ability to restore it is not proven here.',
  'Trace spans are bounded and best effort. Missing spans are not evidence that a step did not happen.',
  'Receipts name the requesting client kind, client id and client name, because those fields are covered by the signature and cannot be removed without breaking it.',
  'Evidence older than a node\'s 100 most recent receipts cannot be exported by this command, so an old action being absent from a bundle says nothing about whether it happened.'
];

function fingerprintKey(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(publicKeyPem.trim()).digest('hex');
}

/** Everything the bundle hash covers: the bundle without the hash field itself. */
function hashableBundle(bundle: EvidenceBundle): Omit<EvidenceBundle, 'bundleHash'> {
  const { bundleHash: _ignored, ...rest } = bundle;
  return rest;
}

export type ExportEvidenceOptions = {
  nodeId: string;
  /** Restrict to one trace. Receipts are then those whose id a span in that trace names. */
  traceId?: string;
  /** Restrict to explicit receipt ids. */
  receiptIds?: string[];
  /** How far back to read the receipt log when neither filter is given. */
  limit?: number;
  /** Deliberate disclosures the author chose to publish alongside the hashes. */
  disclosures?: EvidenceDisclosure[];
};

/**
 * The most receipts `listReceipts` will return, whatever limit it is given. Stated here so the
 * refusal below can name the real constraint instead of suggesting a larger --limit that the reader
 * would then find does nothing.
 */
const RECEIPT_WINDOW = 100;

export class EvidenceExportError extends Error {}

/**
 * Build a bundle from node-local evidence.
 *
 * Everything included is either already public (a public key), already a hash, or already sanitized
 * by the subsystem that produced it. Receipts go in verbatim because they are signed and any edit
 * would destroy the only thing that makes them evidence; they contain hashes rather than content by
 * construction. Spans are re-sanitized on the way in rather than trusted, so a span written by an
 * older build with a field that is no longer allowed cannot ride into a shareable artifact.
 */
export async function exportEvidenceBundle(options: ExportEvidenceOptions): Promise<EvidenceBundle> {
  const traceId = options.traceId ?? null;
  if (traceId !== null && !isValidTraceId(traceId)) throw new EvidenceExportError('invalid trace id');

  const spans = traceId ? (await readTrace(traceId)).map(sanitizeSpan) : [];
  if (traceId && !spans.length) throw new EvidenceExportError(`no trace ${traceId} on this node`);

  const available = await listReceipts(options.nodeId, Math.max(1, Math.min(options.limit ?? RECEIPT_WINDOW, RECEIPT_WINDOW)));
  const wanted = new Set<string>(options.receiptIds ?? []);
  for (const span of spans) if (span.receiptId) wanted.add(span.receiptId);

  // Preserve the log's own order. The chain is defined by that order, so re-sorting by anything
  // else -- a timestamp, an id -- would manufacture breaks that are not in the node's record.
  const receipts = wanted.size ? available.filter(receipt => wanted.has(receipt.receiptId)) : available;

  // The specific complaint comes first. When a caller named receipts that are not here, telling them
  // "nothing matched" describes the symptom and hides which ones, which is how someone concludes the
  // evidence never existed rather than that they asked for the wrong ids or too small a window.
  const missing = [...wanted].filter(id => !receipts.some(receipt => receipt.receiptId === id));
  if (missing.length) {
    throw new EvidenceExportError(
      `receipts not found in the ${available.length} most recent on this node: ${missing.join(', ')}. Exporting a bundle that silently omits requested evidence would misrepresent it. Note that the receipt reader returns at most ${RECEIPT_WINDOW} entries, so evidence older than that cannot be exported by this command.`
    );
  }
  if (!receipts.length) throw new EvidenceExportError('no receipts matched; a bundle with no receipts would carry no evidence');

  const keys = new Set(receipts.map(receipt => receipt.publicKey));
  if (keys.size !== 1) {
    throw new EvidenceExportError(
      `receipts in this range carry ${keys.size} different signing keys; export a narrower range so the bundle names one key honestly`
    );
  }
  const receiptPublicKey = receipts[0]!.publicKey;

  const disclosures = (options.disclosures ?? []).map(entry => ({
    receiptId: entry.receiptId,
    operation: entry.operation,
    args: entry.args
  }));
  for (const disclosure of disclosures) {
    if (!receipts.some(receipt => receipt.receiptId === disclosure.receiptId)) {
      throw new EvidenceExportError(`disclosure names receipt ${disclosure.receiptId}, which is not in this bundle`);
    }
  }

  const base: Omit<EvidenceBundle, 'bundleHash'> = {
    version: EVIDENCE_BUNDLE_VERSION,
    bundleId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    nodeId: options.nodeId,
    receiptPublicKey,
    receiptPublicKeyFingerprint: fingerprintKey(receiptPublicKey),
    traceId,
    receipts,
    spans,
    disclosures,
    limitations: [...LIMITATIONS]
  };
  return { ...base, bundleHash: hashValue(base) };
}

/**
 * Fields every receipt must actually have before any claim is evaluated.
 *
 * A verifier is handed bundles by strangers, so a malformed one has to become a readable FAIL rather
 * than an exception. Checking the shape here, once, is what lets every claim below index into these
 * objects without guarding each access and without a rubbish bundle taking the verifier down with it.
 */
const RECEIPT_STRINGS = ['receiptId', 'at', 'nodeId', 'operation', 'requestHash', 'resultHash', 'policyHash', 'publicKey', 'signature', 'receiptHash'] as const;

function looksLikeReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (RECEIPT_STRINGS.some(field => typeof raw[field] !== 'string')) return false;
  if (raw.previousHash !== null && typeof raw.previousHash !== 'string') return false;
  if (raw.checkpointId !== null && raw.checkpointId !== undefined && typeof raw.checkpointId !== 'string') return false;
  return typeof raw.ok === 'boolean';
}

function looksLikeSpan(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.traceId === 'string' && typeof raw.spanId === 'string' && typeof raw.stage === 'string';
}

function looksLikeDisclosure(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.receiptId === 'string' && typeof raw.operation === 'string'
    && Boolean(raw.args) && typeof raw.args === 'object' && !Array.isArray(raw.args);
}

function decodeBundle(value: unknown): EvidenceBundle | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<EvidenceBundle>;
  if (raw.version !== EVIDENCE_BUNDLE_VERSION) return null;
  if (typeof raw.bundleId !== 'string' || typeof raw.createdAt !== 'string') return null;
  if (typeof raw.nodeId !== 'string' || typeof raw.receiptPublicKey !== 'string') return null;
  if (typeof raw.receiptPublicKeyFingerprint !== 'string' || typeof raw.bundleHash !== 'string') return null;
  if (raw.traceId !== null && typeof raw.traceId !== 'string') return null;
  if (!Array.isArray(raw.receipts) || !raw.receipts.length || !raw.receipts.every(looksLikeReceipt)) return null;
  if (!Array.isArray(raw.spans) || !raw.spans.every(looksLikeSpan)) return null;
  if (!Array.isArray(raw.disclosures) || !raw.disclosures.every(looksLikeDisclosure)) return null;
  if (!Array.isArray(raw.limitations) || !raw.limitations.every(entry => typeof entry === 'string')) return null;
  return raw as EvidenceBundle;
}

function claim(claimName: string, status: EvidenceClaimStatus, detail: string): EvidenceClaim {
  return { claim: claimName, status, detail };
}

/**
 * Check a bundle offline and answer each claim on its own terms.
 *
 * The verifier never reads node state, never touches the network and never consults anything beyond
 * the bundle it was handed. That is the point: a bundle that only verifies on the machine that made
 * it is not portable evidence.
 */
export function verifyEvidenceBundle(value: unknown): EvidenceVerification {
  const bundle = decodeBundle(value);
  if (!bundle) {
    return {
      bundleId: null,
      nodeId: null,
      receiptPublicKeyFingerprint: null,
      claims: [claim('bundle format', 'fail', 'This is not a version 1 DEX//REACH evidence bundle, or required fields are missing or the wrong type. Nothing else could be checked.')],
      summary: { pass: 0, fail: 1, notIncluded: 0, notProven: 0 }
    };
  }

  const claims: EvidenceClaim[] = [];

  // 1. Integrity. A checksum, explicitly not a signature: anyone who edits a bundle can recompute
  //    it. What stops silent edits is the receipt signatures below, not this.
  const recomputed = hashValue(hashableBundle(bundle));
  claims.push(bundle.bundleHash === recomputed
    ? claim('bundle integrity', 'pass', 'The bundle hash matches its contents. This is a checksum against accidental damage; anyone who edits a bundle can recompute it, so it is not evidence of authorship.')
    : claim('bundle integrity', 'fail', `The bundle hash does not match its contents (expected ${recomputed}). The bundle was altered or truncated after it was written.`));

  // 2. Signatures, against the key the bundle carries.
  const badSignatures = bundle.receipts.filter(receipt => !verifyReceipt(receipt));
  claims.push(badSignatures.length === 0
    ? claim('receipt signatures', 'pass', `All ${bundle.receipts.length} receipts verify under the Ed25519 key each carries. This proves the receipts were not edited after signing.`)
    : claim('receipt signatures', 'fail', `${badSignatures.length} of ${bundle.receipts.length} receipts do not verify: ${badSignatures.map(receipt => receipt.receiptId).join(', ')}.`));

  // 3. One key, and it is the key the bundle names.
  const keys = new Set(bundle.receipts.map(receipt => receipt.publicKey));
  const declaredMatches = keys.size === 1 && [...keys][0] === bundle.receiptPublicKey
    && fingerprintKey(bundle.receiptPublicKey) === bundle.receiptPublicKeyFingerprint;
  claims.push(declaredMatches
    ? claim('signing key consistency', 'pass', 'Every receipt carries the same public key, and it is the key this bundle names, with a matching fingerprint.')
    : claim('signing key consistency', 'fail', keys.size === 1
      ? 'The receipts agree on a key, but it is not the one the bundle names, or the stated fingerprint does not match it.'
      : `The receipts carry ${keys.size} different signing keys, so this bundle does not represent one node's chain.`));

  // 4. The node id the bundle advertises, against the one inside the signatures. Without this, a
  //    bundle could be relabelled as any node and recomputing the checksum would hide it entirely:
  //    the receipts would say one thing and every visible summary line another, with no failure.
  const receiptNodes = new Set(bundle.receipts.map(receipt => receipt.nodeId));
  const nodeMatches = receiptNodes.size === 1 && receiptNodes.has(bundle.nodeId);
  claims.push(nodeMatches
    ? claim('node id consistency', 'pass', `The bundle is labelled "${bundle.nodeId}" and every signed receipt inside it names that same node.`)
    : claim('node id consistency', 'fail', receiptNodes.size === 1
      ? `The bundle is labelled "${bundle.nodeId}" but its signed receipts name "${[...receiptNodes][0]}". The label was changed; the signatures were not.`
      : `The receipts name ${receiptNodes.size} different nodes (${[...receiptNodes].join(', ')}), so this is not one node's chain.`));

  // 5. The claim a bundle can never make for itself.
  claims.push(claim('node identity', 'not-proven',
    `The bundle says it came from node "${bundle.nodeId}" with key fingerprint ${bundle.receiptPublicKeyFingerprint}. A forger can sign an internally perfect bundle with their own key, so binding this to a real node means comparing that fingerprint against a key you already trust. Nothing inside a bundle can do that for you.`));

  // 6. Chain continuity within the bundle.
  const breaks: string[] = [];
  for (let index = 1; index < bundle.receipts.length; index += 1) {
    const previous = bundle.receipts[index - 1]!;
    const current = bundle.receipts[index]!;
    if (current.previousHash !== previous.receiptHash) breaks.push(current.receiptId);
  }
  claims.push(breaks.length === 0
    ? claim('receipt chain', 'pass', `The ${bundle.receipts.length} receipts form one unbroken predecessor chain in the order given.`)
    : claim('receipt chain', 'fail', `The chain is broken before: ${breaks.join(', ')}. Either receipts between them are missing, or the order was changed.`));

  // 7. Whether that chain reaches the node's first receipt.
  const first = bundle.receipts[0];
  claims.push(first && first.previousHash === null
    ? claim('chain anchored to node genesis', 'pass', 'The first receipt in this bundle is the first receipt this node ever wrote, so nothing precedes it.')
    : claim('chain anchored to node genesis', 'not-included', `This bundle starts mid-chain; its first receipt follows one with hash ${first?.previousHash ?? 'unknown'}, which is not included. That earlier history is neither shown nor contradicted.`));

  // 8. The structural limit of any bundle.
  claims.push(claim('bundle completeness', 'not-proven',
    'Receipts removed from either end of the range leave no gap, so an unbroken chain does not prove nothing was left out. Completeness can only be established against the node\'s own log.'));

  // 9. Trace linkage.
  if (!bundle.spans.length) {
    claims.push(claim('trace linkage', 'not-included', 'No trace spans were exported, so the causal chain between the request, the authorization decision and the execution is not shown here.'));
  } else {
    const problems: string[] = [];
    const spanIds = new Set(bundle.spans.map(span => span.spanId));
    const receiptIds = new Set(bundle.receipts.map(receipt => receipt.receiptId));
    for (const span of bundle.spans) {
      if (bundle.traceId && span.traceId !== bundle.traceId) problems.push(`span ${span.spanId} belongs to a different trace`);
      if (span.parentSpanId && !spanIds.has(span.parentSpanId)) problems.push(`span ${span.spanId} names a parent that is not in this bundle`);
      if (span.receiptId && !receiptIds.has(span.receiptId)) problems.push(`span ${span.spanId} names receipt ${span.receiptId}, which is not in this bundle`);
    }
    claims.push(problems.length === 0
      ? claim('trace linkage', 'pass', `All ${bundle.spans.length} spans share trace ${bundle.traceId ?? bundle.spans[0]!.traceId}, every parent resolves inside the bundle, and every receipt a span names is present.`)
      : claim('trace linkage', 'fail', problems.join('; ')));
    claims.push(claim('trace completeness', 'not-proven',
      'The trace store is bounded and tracing is best effort, so a step with no span here is not evidence that the step did not happen.'));
  }

  // 10. Request and policy hashes, recomputable only against a deliberate disclosure.
  if (!bundle.disclosures.length) {
    claims.push(claim('request hash', 'not-included',
      'Each receipt carries the hash of the operation and arguments it covers, but the arguments themselves are withheld, so the hash cannot be recomputed here. Note that a hash of a guessable command can still be tested against a guess; it conceals, it does not seal.'));
  } else {
    const mismatched: string[] = [];
    const unmatched: string[] = [];
    for (const disclosure of bundle.disclosures) {
      const receipt = bundle.receipts.find(entry => entry.receiptId === disclosure.receiptId);
      if (!receipt) { unmatched.push(disclosure.receiptId); continue; }
      const expected = crypto.createHash('sha256')
        .update(JSON.stringify({ operation: disclosure.operation, args: disclosure.args }))
        .digest('hex');
      if (expected !== receipt.requestHash) mismatched.push(disclosure.receiptId);
    }
    claims.push(mismatched.length === 0 && unmatched.length === 0
      ? claim('request hash', 'pass', `${bundle.disclosures.length} disclosed request(s) hash to exactly the value the signed receipt carries, so the disclosure is what was actually run. Receipts without a disclosure remain unrecomputable.`)
      : claim('request hash', 'fail', [
        mismatched.length ? `disclosed request does not match the receipt hash for: ${mismatched.join(', ')}` : '',
        unmatched.length ? `disclosure names receipts not in this bundle: ${unmatched.join(', ')}` : ''
      ].filter(Boolean).join('; ')));
  }

  claims.push(claim('owner policy', 'not-included',
    'Each receipt carries the hash of the owner policy that authorized it. The policy itself is withheld, so what the owner had allowed at that moment cannot be read from this bundle.'));

  const checkpoints = bundle.receipts.filter(receipt => receipt.checkpointId).map(receipt => receipt.checkpointId!);
  claims.push(claim('checkpoint', 'not-included', checkpoints.length
    ? `Checkpoint identifier(s) recorded: ${[...new Set(checkpoints)].join(', ')}. The checkpoint contents are not in this bundle and its restorability is not proven here.`
    : 'No receipt in this bundle recorded a checkpoint. That means none was taken or none applied, not that a mutation was irreversible.'));

  claims.push(claim('execution output', 'not-included',
    'Standard output, standard error and file contents are excluded by design. Each receipt carries a hash of its result, which can confirm a result you already hold but cannot reveal one you do not.'));

  claims.push(claim('external side effect', 'not-proven',
    'A receipt records what the node was asked to do and what it reported. Nothing here proves a file, a repository, a device or a remote system actually changed. Confirming that means looking at the system itself.'));

  const summary = {
    pass: claims.filter(entry => entry.status === 'pass').length,
    fail: claims.filter(entry => entry.status === 'fail').length,
    notIncluded: claims.filter(entry => entry.status === 'not-included').length,
    notProven: claims.filter(entry => entry.status === 'not-proven').length
  };

  return {
    bundleId: bundle.bundleId,
    nodeId: bundle.nodeId,
    receiptPublicKeyFingerprint: bundle.receiptPublicKeyFingerprint,
    claims,
    summary
  };
}

const STATUS_LABEL: Record<EvidenceClaimStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  'not-included': 'NOT INCLUDED',
  'not-proven': 'NOT PROVEN'
};

/**
 * Human-readable verification output.
 *
 * There is deliberately no headline verdict. A reader who wants one word will not find it, which is
 * the intended outcome: the failure this format exists to prevent is someone reading VERIFIED and
 * believing the thing actually happened out in the world.
 */
export function formatEvidenceVerification(result: EvidenceVerification): string[] {
  const width = Math.max(...result.claims.map(entry => entry.claim.length));
  const lines = [
    `Bundle ${result.bundleId ?? '(unreadable)'}`,
    `Node claimed: ${result.nodeId ?? '(unreadable)'}`,
    `Signing key fingerprint: ${result.receiptPublicKeyFingerprint ?? '(unreadable)'}`,
    ''
  ];
  for (const entry of result.claims) {
    lines.push(`${entry.claim.padEnd(width)}  ${STATUS_LABEL[entry.status]}`);
    lines.push(`${' '.repeat(width)}  ${entry.detail}`);
    lines.push('');
  }
  lines.push(
    `${result.summary.pass} checks passed, ${result.summary.fail} failed, ${result.summary.notIncluded} not included, ${result.summary.notProven} not proven.`,
    'There is no overall verdict on purpose. Read the claims that matter for your decision; a bundle cannot tell you that the world changed.'
  );
  return lines;
}

/** Serialize a bundle the way it must be written and read back: canonical, so its hash is stable. */
export function serializeEvidenceBundle(bundle: EvidenceBundle): string {
  return canonicalJson(bundle) + '\n';
}
