import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  EVIDENCE_BUNDLE_VERSION,
  EvidenceExportError,
  exportEvidenceBundle,
  formatEvidenceVerification,
  serializeEvidenceBundle,
  verifyEvidenceBundle,
  type EvidenceBundle,
  type EvidenceClaimStatus
} from '../src/shared/evidence.js';
import { appendReceipt } from '../src/shared/receipts.js';
import { newSpanId, newTraceId, recordSpan } from '../src/shared/trace.js';
import { hashValue } from '../src/shared/hash.js';
import type { RequestActor } from '../src/shared/protocol.js';

/**
 * Phase 13 — portable evidence bundles.
 *
 * Two things are being tested. That a bundle carries what it should and nothing it should not, which
 * is checked by searching a real exported bundle for content that must never be in it rather than by
 * asserting a field is absent. And that verification answers each claim separately: the failure this
 * whole design exists to prevent is a reader seeing one word and believing more than the evidence
 * supports, so the tests assert that no claim is over-stated and that a tampered bundle fails
 * precisely and locally rather than everywhere or nowhere.
 */

const actor: RequestActor = { kind: 'claude', clientId: 'c1', clientName: 'Claude' };
const NODE = 'evidence-node';

/** Distinctive strings that must never survive into a bundle. */
const FILE_CONTENT = 'zq4-SENTINEL-FILE-BODY-8812';
const COMMAND_TEXT = 'zq4-SENTINEL-COMMAND-4471';
const STDOUT_TEXT = 'zq4-SENTINEL-STDOUT-9930';
const POLICY_TEXT = 'zq4-SENTINEL-POLICY-2264';

async function withStateDir<T>(label: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dex-reach-${label}-`));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  try {
    return await body(dir);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A node that has actually done work: two receipts, a trace linking spans to the second one. */
async function seedNode(): Promise<{ traceId: string; receiptIds: string[] }> {
  const traceId = newTraceId();
  const first = await appendReceipt({
    nodeId: NODE, actor, operation: 'dex.file.write',
    args: { path: '/tmp/report.txt', text: FILE_CONTENT },
    ok: true, result: { bytes: FILE_CONTENT.length }, durationMs: 4,
    policy: { mode: 'on', note: POLICY_TEXT }, checkpointId: 'cp-1'
  });
  const second = await appendReceipt({
    nodeId: NODE, actor, operation: 'dex.process.run',
    args: { command: COMMAND_TEXT, cwd: '/tmp' },
    ok: true, result: { exitCode: 0, stdout: STDOUT_TEXT, stderr: '' }, durationMs: 11,
    policy: { mode: 'on', note: POLICY_TEXT }, checkpointId: null
  });
  const root = newSpanId();
  await recordSpan({ traceId, spanId: root, stage: 'gateway', at: new Date().toISOString(), operation: 'dex.process.run', nodeId: NODE, actorKind: actor.kind, ok: true });
  await recordSpan({ traceId, spanId: newSpanId(), parentSpanId: root, stage: 'authorize', at: new Date().toISOString(), operation: 'dex.process.run', nodeId: NODE, ok: true, policyHash: second.policyHash });
  await recordSpan({ traceId, spanId: newSpanId(), parentSpanId: root, stage: 'receipt', at: new Date().toISOString(), operation: 'dex.process.run', nodeId: NODE, ok: true, receiptId: second.receiptId });
  return { traceId, receiptIds: [first.receiptId, second.receiptId] };
}

function statusOf(claims: { claim: string; status: EvidenceClaimStatus }[], name: string): EvidenceClaimStatus {
  const found = claims.find(entry => entry.claim === name);
  assert.ok(found, `no claim named "${name}"; claims were: ${claims.map(entry => entry.claim).join(', ')}`);
  return found.status;
}

test('a bundle carries hashes and signatures, and none of the content they stand for', async () => {
  await withStateDir('evidence-export', async () => {
    const { traceId } = await seedNode();
    const bundle = await exportEvidenceBundle({ nodeId: NODE, traceId });

    // Present, because the bundle is worthless without them.
    assert.equal(bundle.version, EVIDENCE_BUNDLE_VERSION);
    assert.equal(bundle.nodeId, NODE);
    assert.equal(bundle.traceId, traceId);
    assert.equal(bundle.receipts.length, 1, 'a trace-scoped export carries the receipts its spans name');
    assert.equal(bundle.spans.length, 3);
    assert.match(bundle.receiptPublicKey, /BEGIN PUBLIC KEY/);
    assert.equal(bundle.receiptPublicKeyFingerprint, crypto.createHash('sha256').update(bundle.receiptPublicKey.trim()).digest('hex'));
    assert.ok(bundle.receipts[0]!.requestHash && bundle.receipts[0]!.policyHash && bundle.receipts[0]!.resultHash);
    assert.ok(bundle.limitations.length >= 5, 'the limitations travel with the bundle, not only with the verifier');

    // Absent, proved by searching the serialized artifact rather than by checking field names. A
    // future field that quietly carries content would pass an absence check and fail this one.
    const serialized = serializeEvidenceBundle(bundle);
    for (const [label, sentinel] of [['file content', FILE_CONTENT], ['command text', COMMAND_TEXT], ['stdout', STDOUT_TEXT], ['raw policy', POLICY_TEXT]] as const) {
      assert.ok(!serialized.includes(sentinel), `${label} leaked into the bundle`);
    }
    assert.ok(!serialized.includes('PRIVATE KEY'), 'a private key must never be in a bundle');
  });
});

test('a bundle written to disk verifies from the file alone, with no node state', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-evidence-file-'));
  try {
    const file = path.join(outside, 'bundle.json');
    await withStateDir('evidence-portable', async () => {
      const { traceId } = await seedNode();
      await fs.writeFile(file, serializeEvidenceBundle(await exportEvidenceBundle({ nodeId: NODE, traceId })));
    });
    // The state directory is gone by the time this runs, which is the actual claim: portability
    // means the bundle verifies without the machine that produced it.
    const result = verifyEvidenceBundle(JSON.parse(await fs.readFile(file, 'utf8')));
    assert.equal(statusOf(result.claims, 'bundle integrity'), 'pass');
    assert.equal(statusOf(result.claims, 'receipt signatures'), 'pass');
    assert.equal(statusOf(result.claims, 'signing key consistency'), 'pass');
    assert.equal(statusOf(result.claims, 'node id consistency'), 'pass');
    assert.equal(statusOf(result.claims, 'trace linkage'), 'pass');
    assert.equal(result.summary.fail, 0);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('verification never collapses into one verdict, and says what each answer does not mean', async () => {
  await withStateDir('evidence-claims', async () => {
    const { traceId } = await seedNode();
    const result = verifyEvidenceBundle(await exportEvidenceBundle({ nodeId: NODE, traceId }));

    // The claims that can never be PASS from inside a bundle, whatever it contains.
    assert.equal(statusOf(result.claims, 'node identity'), 'not-proven');
    assert.equal(statusOf(result.claims, 'bundle completeness'), 'not-proven');
    assert.equal(statusOf(result.claims, 'external side effect'), 'not-proven');
    assert.equal(statusOf(result.claims, 'trace completeness'), 'not-proven');
    assert.equal(statusOf(result.claims, 'execution output'), 'not-included');
    assert.equal(statusOf(result.claims, 'owner policy'), 'not-included');

    // Every claim explains itself. A status with no detail is how a reader ends up guessing.
    for (const entry of result.claims) assert.ok(entry.detail.length > 40, `claim "${entry.claim}" has no real explanation`);

    // There is no single overall verdict anywhere in the output, by design.
    const text = formatEvidenceVerification(result).join('\n');
    assert.ok(!/^\s*VERIFIED\s*$/mi.test(text), 'the formatter must not print a bare VERIFIED');
    assert.ok(text.includes('There is no overall verdict on purpose.'));
    assert.ok(text.includes('NOT PROVEN') && text.includes('NOT INCLUDED') && text.includes('PASS'));
    assert.equal(result.summary.pass + result.summary.fail + result.summary.notIncluded + result.summary.notProven, result.claims.length);
  });
});

test('an edited receipt fails its own claim and leaves the others answerable', async () => {
  await withStateDir('evidence-tamper', async () => {
    await seedNode();
    const bundle = await exportEvidenceBundle({ nodeId: NODE });
    assert.equal(bundle.receipts.length, 2);

    // Flip the outcome of a real action. This is the forgery the signature exists to catch, and it
    // must be caught by the signature check specifically rather than by a vague overall failure.
    const forged = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    forged.receipts[1]!.ok = false;
    const result = verifyEvidenceBundle(forged);
    assert.equal(statusOf(result.claims, 'receipt signatures'), 'fail');
    assert.equal(statusOf(result.claims, 'bundle integrity'), 'fail', 'the checksum notices too, since the edit changed the contents');
    // The chain is still structurally intact, because the edited field is not part of the link. The
    // verifier must say so rather than failing every claim once one fails.
    assert.equal(statusOf(result.claims, 'receipt chain'), 'pass');
    assert.ok(result.summary.pass > 0, 'one bad receipt must not invalidate answers that are still true');
  });
});

test('a removed middle receipt breaks the chain; a removed end receipt does not, and the bundle says so', async () => {
  await withStateDir('evidence-slice', async () => {
    await seedNode();
    await appendReceipt({ nodeId: NODE, actor, operation: 'dex.repoInfo', args: { cwd: '/tmp' }, ok: true, result: { branch: 'main' }, durationMs: 1, policy: { mode: 'on' } });
    const full = await exportEvidenceBundle({ nodeId: NODE });
    assert.equal(full.receipts.length, 3);
    assert.equal(statusOf(verifyEvidenceBundle(full).claims, 'receipt chain'), 'pass');
    assert.equal(statusOf(verifyEvidenceBundle(full).claims, 'chain anchored to node genesis'), 'pass');

    const gapped = JSON.parse(JSON.stringify(full)) as EvidenceBundle;
    gapped.receipts.splice(1, 1);
    const gappedResult = verifyEvidenceBundle(gapped);
    assert.equal(statusOf(gappedResult.claims, 'receipt chain'), 'fail', 'a receipt removed from the middle leaves a gap');

    // A slice taken from the end leaves no gap at all, which is exactly why completeness cannot be
    // inferred from an unbroken chain. The verifier must not report the slice as complete.
    const trimmed = await exportEvidenceBundle({ nodeId: NODE, receiptIds: [full.receipts[1]!.receiptId, full.receipts[2]!.receiptId] });
    const trimmedResult = verifyEvidenceBundle(trimmed);
    assert.equal(statusOf(trimmedResult.claims, 'receipt chain'), 'pass');
    assert.equal(statusOf(trimmedResult.claims, 'chain anchored to node genesis'), 'not-included');
    assert.equal(statusOf(trimmedResult.claims, 'bundle completeness'), 'not-proven');
  });
});

test('a bundle re-signed with an attacker key is internally perfect and still proves no identity', async () => {
  await withStateDir('evidence-forgery', async () => {
    await seedNode();
    const honest = await exportEvidenceBundle({ nodeId: NODE });

    // Rebuild the whole chain under a key the attacker controls, exactly as a forger would. Every
    // structural claim below passes. That is the point: signature validity is not provenance, and
    // the only claim that would have caught this is the one a bundle can never answer for itself.
    const attacker = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
        : item);
    const forgedReceipts: Record<string, unknown>[] = [];
    let previousHash: string | null = null;
    for (const receipt of honest.receipts) {
      const { signature: _s, receiptHash: _h, ...rest } = receipt;
      const base: Record<string, unknown> = { ...rest, previousHash, publicKey: attacker.publicKey, ok: false };
      const signature = crypto.sign(null, Buffer.from(canonical(base)), attacker.privateKey).toString('base64');
      const receiptHash: string = crypto.createHash('sha256').update(canonical({ ...base, signature })).digest('hex');
      forgedReceipts.push({ ...base, signature, receiptHash });
      previousHash = receiptHash;
    }
    const forged = {
      ...honest,
      receipts: forgedReceipts,
      receiptPublicKey: attacker.publicKey,
      receiptPublicKeyFingerprint: crypto.createHash('sha256').update(attacker.publicKey.trim()).digest('hex')
    };
    const { bundleHash: _drop, ...hashable } = forged;
    const result = verifyEvidenceBundle({ ...forged, bundleHash: crypto.createHash('sha256').update(canonical(hashable)).digest('hex') });

    assert.equal(statusOf(result.claims, 'receipt signatures'), 'pass');
    assert.equal(statusOf(result.claims, 'signing key consistency'), 'pass');
    assert.equal(statusOf(result.claims, 'receipt chain'), 'pass');
    assert.equal(result.summary.fail, 0, 'a competent forgery is internally flawless, which is why identity is a separate claim');
    assert.equal(statusOf(result.claims, 'node identity'), 'not-proven');
    assert.notEqual(result.receiptPublicKeyFingerprint, honest.receiptPublicKeyFingerprint,
      'the fingerprint is what a verifier compares against a key they already trust, and it differs');
  });
});

test('a disclosed request is checked against the signed hash rather than believed', async () => {
  await withStateDir('evidence-disclosure', async () => {
    await seedNode();
    const plain = await exportEvidenceBundle({ nodeId: NODE });
    assert.equal(statusOf(verifyEvidenceBundle(plain).claims, 'request hash'), 'not-included');

    const target = plain.receipts[1]!;
    const truthful = await exportEvidenceBundle({
      nodeId: NODE,
      disclosures: [{ receiptId: target.receiptId, operation: 'dex.process.run', args: { command: COMMAND_TEXT, cwd: '/tmp' } }]
    });
    assert.equal(statusOf(verifyEvidenceBundle(truthful).claims, 'request hash'), 'pass');

    // A disclosure that claims something gentler than what was actually run must not pass.
    const dishonest = await exportEvidenceBundle({
      nodeId: NODE,
      disclosures: [{ receiptId: target.receiptId, operation: 'dex.process.run', args: { command: 'ls', cwd: '/tmp' } }]
    });
    assert.equal(statusOf(verifyEvidenceBundle(dishonest).claims, 'request hash'), 'fail');

    // Disclosing publishes the arguments, so this is the one place a bundle stops being
    // content-free. The test states that plainly rather than leaving it to be discovered.
    assert.ok(serializeEvidenceBundle(truthful).includes(COMMAND_TEXT));
    assert.ok(!serializeEvidenceBundle(plain).includes(COMMAND_TEXT));

    await assert.rejects(
      exportEvidenceBundle({ nodeId: NODE, disclosures: [{ receiptId: 'not-a-receipt', operation: 'x', args: {} }] }),
      EvidenceExportError
    );
  });
});

test('an export that cannot honour what was asked refuses instead of quietly narrowing it', async () => {
  await withStateDir('evidence-refusals', async () => {
    await assert.rejects(exportEvidenceBundle({ nodeId: NODE }), /no receipts matched/);
    await seedNode();
    await assert.rejects(exportEvidenceBundle({ nodeId: NODE, traceId: 'not-a-trace-id' }), /invalid trace id/);
    await assert.rejects(exportEvidenceBundle({ nodeId: NODE, traceId: newTraceId() }), /no trace/);
    await assert.rejects(exportEvidenceBundle({ nodeId: NODE, receiptIds: ['missing-one'] }), /receipts not found/);
  });
});


test('relabelling a bundle as another node is caught by the signatures it did not rewrite', async () => {
  await withStateDir('evidence-relabel', async () => {
    await seedNode();
    const honest = await exportEvidenceBundle({ nodeId: NODE });

    // The bundle hash is a checksum, so anyone who edits a bundle can recompute it. Before this was
    // checked, relabelling the bundle as a machine the reader trusts produced zero failures while
    // the verifier's own summary printed the false name.
    const { bundleHash: _drop, ...rest } = honest;
    const relabelled = { ...rest, nodeId: 'a-node-you-trust' };
    const forged = { ...relabelled, bundleHash: hashValue(relabelled) };

    const result = verifyEvidenceBundle(forged);
    assert.equal(statusOf(result.claims, 'bundle integrity'), 'pass', 'the checksum was recomputed, so integrity alone would not have caught this');
    assert.equal(statusOf(result.claims, 'receipt signatures'), 'pass');
    assert.equal(statusOf(result.claims, 'node id consistency'), 'fail');
    assert.ok(result.claims.find(entry => entry.claim === 'node id consistency')!.detail.includes(NODE),
      'the failure must name the node the signatures actually attest to');
  });
});

test('a structurally broken bundle is reported as unreadable instead of taking the verifier down', () => {
  // A verifier is handed bundles by strangers. Before these shapes were checked, a receipts array
  // holding null threw out of verifyEvidenceBundle, so the caller got a stack trace rather than an
  // answer -- and a crash is far easier to mistake for a tooling problem than for a bad bundle.
  const shell = {
    version: 1, bundleId: 'b', createdAt: 'now', nodeId: 'n',
    receiptPublicKey: 'k', receiptPublicKeyFingerprint: 'f', traceId: null,
    receipts: [], spans: [], disclosures: [], limitations: [], bundleHash: 'h'
  };
  for (const broken of [
    { ...shell, receipts: [null] },
    { ...shell, receipts: [{ receiptId: 'r' }] },
    { ...shell, receipts: [{ ...shell, ok: 'yes' }] },
    { ...shell, receipts: [], spans: [null] },
    { ...shell, receipts: [] },
    { ...shell, disclosures: [{ receiptId: 'r' }] },
    { ...shell, limitations: [42] }
  ]) {
    const result = verifyEvidenceBundle(broken);
    assert.equal(result.claims.length, 1, `expected one unreadable claim for ${JSON.stringify(broken).slice(0, 60)}`);
    assert.equal(result.claims[0]!.status, 'fail');
  }
});

test('an export names the receipts it could not find and the real window it searched', async () => {
  await withStateDir('evidence-window', async () => {
    await seedNode();
    await assert.rejects(
      exportEvidenceBundle({ nodeId: NODE, receiptIds: ['aaaa-missing'] }),
      // Naming the ids matters: "no receipts matched" would let a reader conclude the evidence never
      // existed rather than that they asked for the wrong ids or for something outside the window.
      (error: Error) => error.message.includes('aaaa-missing') && /most recent/.test(error.message) && /at most 100/.test(error.message)
    );
  });
});

test('rubbish and near-miss bundles are refused as unreadable rather than partly believed', () => {
  for (const value of [null, 'a string', 42, [], {}, { version: 2 }]) {
    const result = verifyEvidenceBundle(value);
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0]!.status, 'fail');
    assert.equal(result.summary.fail, 1);
    assert.equal(result.bundleId, null);
  }
});
