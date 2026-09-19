import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MIN_SCRUBBABLE_SECRET_LENGTH,
  NO_SECRETS,
  SecretStoreCorruptError,
  listSecretAliases,
  removeSecret,
  requestedSecretAliases,
  resolveSecrets,
  scrubSecretsDeep,
  scrubSecretValues,
  secretInjectionRefusal,
  secretsFile,
  setSecret
} from '../src/shared/secrets.js';
import { nativeCall, nativeProcess } from '../src/node/native.js';
import { createPlan } from '../src/shared/plans.js';
import { AuditLog } from '../src/shared/audit.js';
import { appendReceipt, listReceipts } from '../src/shared/receipts.js';
import { newSpanId, newTraceId, recordSpan } from '../src/shared/trace.js';
import { collectDoctorReport } from '../src/shared/doctor.js';
import { REACH_CAPABILITIES, requiredCapabilities } from '../src/shared/capabilities.js';
import { authorizeOperation, type AccessState } from '../src/shared/access.js';
import type { RequestActor } from '../src/shared/protocol.js';

/**
 * Phase 12 — the EXPERIMENTAL node-local secret broker.
 *
 * The central claim is a negative one: a stored value reaches exactly one child process and appears
 * nowhere else. A test that asserts "I remembered to redact" proves nothing about the places I did
 * not think of, so the first test here does not assert redaction at all. It drives a real value
 * through a real child process, a plan, the audit log, a signed receipt, a trace and the shareable
 * doctor report, then walks every byte written under the state directory looking for the value
 * itself. Anything that holds it, other than the 0600 store, fails the test by name.
 */

const NODE = 'secret-node';
const actor: RequestActor = { kind: 'claude', clientId: 'c1', clientName: 'Claude' };

/** A value no other part of the tree could produce, so a hit is never a coincidence. */
const VALUE = 'kx7Qv-SENTINEL-SECRET-VALUE-3f81a2c9';

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

/** Every file under a directory, as bytes. Not text: a value could be written in any encoding. */
async function everyFile(dir: string): Promise<{ file: string; bytes: Buffer }[]> {
  const out: { file: string; bytes: Buffer }[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push({ file: path.relative(dir, full), bytes: await fs.readFile(full) });
    }
  };
  await walk(dir);
  return out;
}

function stateWith(capabilities: string[]): AccessState {
  return {
    version: 3, revision: 1, mode: 'on', until: null, revertTo: null,
    clients: {}, grantRequired: { claude: true },
    grants: [{
      id: 'g1', client: 'claude', capabilities: capabilities as never, roots: [os.tmpdir()],
      until: new Date(Date.now() + 3_600_000).toISOString(), maxUses: null, uses: 0,
      createdAt: new Date().toISOString()
    }],
    updatedAt: new Date().toISOString()
  };
}

test('a stored value reaches the child process and appears in no other artifact on disk', async () => {
  await withStateDir('secret-leak', async dir => {
    await setSecret(NODE, 'deploy-token', 'DEPLOY_TOKEN', VALUE, dir);

    // The positive control has to come first. If injection silently did nothing, every "the value is
    // not on disk" assertion below would pass for the wrong reason, which is exactly the failure
    // mode this whole file exists to rule out. `test -n` reports the value arrived without printing
    // it; the echo afterwards proves the scrubber, not the injection.
    const resolved = await resolveSecrets(NODE, ['deploy-token'], dir);
    assert.deepEqual(Object.keys(resolved.env), ['DEPLOY_TOKEN']);
    assert.equal(resolved.env.DEPLOY_TOKEN, VALUE);

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-secret-cwd-'));
    try {
      const present = await nativeProcess('test -n "$DEPLOY_TOKEN" && echo INJECTED', cwd, 'development', 15_000, [cwd], resolved);
      // Exact stdout is not asserted anywhere in this file: `sh -lc` sources login profiles, and on
      // some machines those print banners into captured output. The substring is the claim.
      assert.equal(present.exitCode, 0);
      assert.ok(String(present.stdout).includes('INJECTED'), 'the resolved value must actually reach the child environment');
      assert.deepEqual(present.secretsUsed, ['deploy-token']);

      const echoed = await nativeProcess('printf %s "$DEPLOY_TOKEN"', cwd, 'development', 15_000, [cwd], resolved);
      assert.ok(String(echoed.stdout).includes('[REDACTED]'), 'a verbatim echo must be scrubbed on the way back');
      assert.ok(!String(echoed.stdout).includes(VALUE));

      // Now drive the same request through every artifact DEX writes, with the result of a command
      // that did hold the value.
      const args = { command: 'printf %s "$DEPLOY_TOKEN"', cwd, secrets: ['deploy-token'] };
      await createPlan({ nodeId: NODE, actor, operation: 'dex.process.run', args, policyHash: 'p', checkpointId: null }, 60_000);
      await new AuditLog().append({ at: new Date().toISOString(), source: 'node', nodeId: NODE, actor, operation: 'dex.process.run', ok: true, args });
      await appendReceipt({ nodeId: NODE, actor, operation: 'dex.process.run', args, ok: true, result: echoed, durationMs: 3, policy: { mode: 'on' } });
      const traceId = newTraceId();
      await recordSpan({ traceId, spanId: newSpanId(), stage: 'execute', at: new Date().toISOString(), operation: 'dex.process.run', nodeId: NODE, actorKind: actor.kind, ok: true });
      const shared = await collectDoctorReport({ share: true, dir, nodeId: NODE });
      const local = await collectDoctorReport({ dir, nodeId: NODE });

      // The negative, proved by search rather than by assertion.
      const store = path.join('nodes', `${NODE}.secrets.json`);
      const written = await everyFile(dir);
      assert.ok(written.length > 4, `expected the run to have written artifacts, found ${written.length}`);
      const holders = written.filter(entry => entry.bytes.includes(VALUE)).map(entry => entry.file);
      assert.deepEqual(holders, [store], `the secret value must exist only in ${store}; it also appeared in: ${holders.filter(file => file !== store).join(', ') || '(nowhere)'}`);
      assert.ok(written.some(entry => entry.file.startsWith('plans/')), 'the plan must have been written, or the walk proved nothing about plans');
      assert.ok(written.some(entry => entry.file === 'audit.jsonl'), 'the audit entry must have been written');
      assert.ok(written.some(entry => entry.file.startsWith('traces/')), 'the trace span must have been written');

      // The two doctor reports are returned to a caller rather than written, so search them too.
      assert.ok(!JSON.stringify(shared).includes(VALUE));
      assert.ok(!JSON.stringify(local).includes(VALUE));
      assert.equal((shared.secrets as { count: number }).count, 1);
      assert.equal((shared.secrets as { aliases?: unknown }).aliases, undefined, 'a shareable report withholds alias names, which describe infrastructure');
      assert.deepEqual((local.secrets as { aliases: string[] }).aliases, ['deploy-token']);

      // Receipts carry hashes, so confirm the chain recorded the call at all rather than trusting
      // that the absence of the value means the receipt was written.
      const receipts = await listReceipts(NODE, 5);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.operation, 'dex.process.run');

      // The audit keeps the alias, which is not a secret and is the only record of what was used.
      const audit = await new AuditLog().tail(5);
      assert.deepEqual((audit[0]?.args as { secrets?: unknown })?.secrets, ['deploy-token']);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test('only the node resolves values: no other module may reach the resolve path', async () => {
  // A structural invariant, not a behavioural one. Phase 12 says values are resolved on the node
  // after final authorization and never at the gateway, in MCP, at request creation or in planning.
  // The way that claim stops being true is a future import, so the import graph is what is checked.
  const root = path.resolve(import.meta.dirname, '..');
  const sources: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) sources.push(full);
    }
  };
  await walk(path.join(root, 'src'));
  await walk(path.join(root, 'scripts'));

  const importers: string[] = [];
  const resolvers: string[] = [];
  for (const file of sources) {
    const text = await fs.readFile(file, 'utf8');
    const relative = path.relative(root, file);
    if (relative === 'src/shared/secrets.ts') continue;
    if (/from '[^']*secrets\.js'/.test(text)) importers.push(relative);
    if (/\bresolveSecrets\s*\(/.test(text)) resolvers.push(relative);
  }

  assert.deepEqual(resolvers, ['src/node/native.ts'], `only the node executor may resolve a secret value; also resolving: ${resolvers.join(', ')}`);
  assert.deepEqual(
    importers.sort(),
    [
      // Owner-side alias management only.
      'scripts/dex-reach.ts',
      // The node's dispatcher, for the pre-execution injection refusal.
      'src/node/main.ts',
      // The node executor: the one resolve site, plus the same refusal repeated.
      'src/node/native.ts',
      // Capability derivation: detects that a request names secrets. No access to values.
      'src/shared/capabilities.ts',
      // Doctor: alias metadata for the owner's own report. No access to values.
      'src/shared/doctor.ts'
    ],
    'a new importer of the secret broker must be reviewed deliberately, not added silently'
  );
  for (const file of importers) {
    assert.ok(!file.startsWith('src/gateway/'), `the gateway must never import the secret broker: ${file}`);
  }

  // The doctor reads alias metadata; it must not be able to read a value even by mistake.
  const doctor = await fs.readFile(path.join(root, 'src/shared/doctor.ts'), 'utf8');
  assert.match(doctor, /import \{ listSecretAliases \} from '\.\/secrets\.js'/);
});

test('naming a secret is its own authority; every other capability combined does not grant it', () => {
  const args = { command: 'deploy', secrets: ['deploy-token'] };
  const required = requiredCapabilities('dex.process.run', args);
  assert.ok(required.includes('process.shell'));
  assert.ok(required.includes('secret.use'));

  const everythingElse = REACH_CAPABILITIES.filter(capability => capability !== 'secret.use');
  const withoutSecretUse = authorizeOperation(stateWith([...everythingElse]), actor, 'dex.process.run', 'development', Date.now(), args);
  assert.equal(withoutSecretUse.allowed, false, 'holding shell, file.write and everything else must not imply secret authority');

  const withSecretUse = authorizeOperation(stateWith([...REACH_CAPABILITIES]), actor, 'dex.process.run', 'development', Date.now(), args);
  assert.equal(withSecretUse.allowed, true);

  // And the converse: secret.use alone does not grant the shell it would be injected into.
  const onlySecretUse = authorizeOperation(stateWith(['secret.use']), actor, 'dex.process.run', 'development', Date.now(), args);
  assert.equal(onlySecretUse.allowed, false);

  // A request that names no secret is unaffected, so the new capability does not silently become
  // mandatory for work that never touches the broker.
  const plain = requiredCapabilities('dex.process.run', { command: 'deploy' });
  assert.ok(!plain.includes('secret.use'));
  assert.equal(authorizeOperation(stateWith(['process.shell']), actor, 'dex.process.run', 'development', Date.now(), { command: 'deploy' }).allowed, true);
});

test('secrets named anywhere in a request are caught, and malformed ones fail closed', () => {
  assert.ok(requiredCapabilities('dex.compat.call', { tool: 'start_process', arguments: { secrets: ['deploy-token'] } }).includes('secret.use'));
  // Not a list of aliases, so nothing can be validated: it still counts as naming secrets rather
  // than being ignored, and the request is refused later by requestedSecretAliases.
  assert.ok(requiredCapabilities('dex.process.run', { secrets: 'deploy-token' }).includes('secret.use'));
  assert.ok(requiredCapabilities('dex.process.run', { secrets: [] }).includes('secret.use'));
  assert.ok(!requiredCapabilities('dex.process.run', { secrets: null }).includes('secret.use'));

  assert.deepEqual(requestedSecretAliases({ secrets: ['b', 'a', 'b'] }), ['b', 'a']);
  assert.deepEqual(requestedSecretAliases({}), []);
  assert.throws(() => requestedSecretAliases({ secrets: 'deploy-token' }), /must be an array/);
  assert.throws(() => requestedSecretAliases({ secrets: ['Deploy-Token'] }), /invalid secret alias/);
  assert.throws(() => requestedSecretAliases({ secrets: ['../../etc/passwd'] }), /invalid secret alias/);
});

test('the broker refuses environment names that steer the child rather than feed it', async () => {
  await withStateDir('secret-env', async dir => {
    for (const env of ['PATH', 'HOME', 'SHELL', 'IFS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BASH_ENV', 'GIT_SSH_COMMAND', 'DEX_REACH_NODE_TOKEN']) {
      await assert.rejects(setSecret('n', 'alias', env, VALUE, dir), /will not inject/, `${env} must be refused`);
    }
    for (const env of ['lowercase', '9LEADING', 'HAS-DASH', '']) {
      await assert.rejects(setSecret('n', 'alias', env, VALUE, dir), /environment variable name must match/);
    }
    await assert.rejects(setSecret('n', 'Bad_Alias', 'TOKEN_A', VALUE, dir), /secret alias must match/);
    await assert.rejects(setSecret('n', 'alias', 'TOKEN_A', `${VALUE}\nPATH=/evil`, dir), /newlines or null bytes/);
    await assert.rejects(setSecret('n', 'alias', 'TOKEN_A', 'short', dir), new RegExp(`shorter than ${MIN_SCRUBBABLE_SECRET_LENGTH}`));
    assert.deepEqual(await listSecretAliases('n', dir), [], 'a refused set must store nothing');
  });
});

test('alias metadata identifies a value without being an offline oracle for it', async () => {
  await withStateDir('secret-meta', async dir => {
    const first = await setSecret('n', 'token-a', 'TOKEN_A', VALUE, dir);
    const same = await setSecret('n', 'token-b', 'TOKEN_B', VALUE, dir);
    const other = await setSecret('n', 'token-c', 'TOKEN_C', `${VALUE}-other`, dir);
    assert.equal(first.replaced, false);
    assert.equal(first.info.fingerprint, same.info.fingerprint, 'two aliases holding one value must be visibly the same');
    assert.notEqual(first.info.fingerprint, other.info.fingerprint);

    // The fingerprint is keyed, so it is not reproducible from the value alone by someone who reads
    // the file. A second store with the same value must produce a different fingerprint.
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-secret-other-'));
    try {
      const rival = await setSecret('n', 'token-a', 'TOKEN_A', VALUE, elsewhere);
      assert.notEqual(rival.info.fingerprint, first.info.fingerprint, 'the fingerprint must be keyed per store, not a bare hash of the value');
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }

    const rotated = await setSecret('n', 'token-a', 'TOKEN_A', `${VALUE}-rotated`, dir);
    assert.equal(rotated.replaced, true);
    assert.notEqual(rotated.info.fingerprint, first.info.fingerprint, 'rotating a value must be visible to the owner');

    const listed = await listSecretAliases('n', dir);
    assert.deepEqual(listed.map(entry => entry.alias), ['token-a', 'token-b', 'token-c']);
    assert.equal(JSON.stringify(listed).includes(VALUE), false, 'listing aliases must never carry a value');

    assert.equal(await removeSecret('n', 'token-b', dir), true);
    assert.equal(await removeSecret('n', 'token-b', dir), false);
    const afterRemoval = await fs.readFile(secretsFile('n', dir), 'utf8');
    assert.equal(afterRemoval.includes('TOKEN_B'), false);
    assert.ok(afterRemoval.includes('TOKEN_A'), 'removing one alias must not disturb the others');

    const mode = (await fs.stat(secretsFile('n', dir))).mode & 0o777;
    assert.equal(mode, 0o600, 'the store must not be readable by other accounts on the machine');
  });
});

test('an unresolvable alias is an error, never a silently missing credential', async () => {
  await withStateDir('secret-missing', async dir => {
    await setSecret('n', 'token-a', 'TOKEN_A', VALUE, dir);
    await assert.rejects(resolveSecrets('n', ['token-b'], dir), /no secret alias "token-b"/);
    // A command that asked for a credential and silently ran without one is the dangerous case: it
    // may authenticate as nobody, or fall back to an ambient identity the owner never authorized.
    assert.deepEqual(await resolveSecrets('n', [], dir), NO_SECRETS);
  });
});

test('a corrupt store throws rather than reporting an empty one', async () => {
  await withStateDir('secret-corrupt', async dir => {
    await setSecret('n', 'token-a', 'TOKEN_A', VALUE, dir);
    const file = secretsFile('n', dir);
    const good = await fs.readFile(file, 'utf8');

    await fs.writeFile(file, '{ not json');
    await assert.rejects(listSecretAliases('n', dir), SecretStoreCorruptError);
    await assert.rejects(resolveSecrets('n', ['token-a'], dir), SecretStoreCorruptError);

    // A hand-edited store that names a forbidden variable is corrupt, not a value to be repaired.
    const tampered = JSON.parse(good) as { secrets: { env: string }[] };
    tampered.secrets[0]!.env = 'LD_PRELOAD';
    await fs.writeFile(file, JSON.stringify(tampered));
    await assert.rejects(resolveSecrets('n', ['token-a'], dir), SecretStoreCorruptError);

    // And the store is never silently replaced: a set against a corrupt store fails rather than
    // writing a fresh empty one over the owner's credentials.
    await assert.rejects(setSecret('n', 'token-d', 'TOKEN_D', VALUE, dir), SecretStoreCorruptError);
    assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(tampered), 'the corrupt file must be left exactly as found');
  });
});

test('scrubbing removes whole values, longest first, and says what it cannot do', () => {
  const long = 'AAAA-BBBB-CCCC';
  const short = 'BBBB-CCCC';
  assert.equal(scrubSecretValues(`x ${long} y`, [short, long]), 'x [REDACTED] y');
  assert.equal(scrubSecretValues('x AAAA y', ['AAAA']), 'x AAAA y', 'values below the floor are left alone rather than mangling ordinary text');
  assert.deepEqual(
    scrubSecretsDeep({ a: `p${long}q`, b: [{ c: long }], d: 3, e: null }, [long]),
    { a: 'p[REDACTED]q', b: [{ c: '[REDACTED]' }], d: 3, e: null }
  );
  assert.deepEqual(scrubSecretsDeep({ a: long }, []), { a: long }, 'with no secrets in play the result is untouched');

  // The honest limit, recorded as a test so it cannot quietly become a claim of safety: a value the
  // command transformed is not caught, which is why injection never makes arbitrary shell safe.
  const encoded = Buffer.from(long).toString('base64');
  assert.equal(scrubSecretValues(encoded, [long]), encoded);
});

test('READ-ONLY admits dex.process.run without consulting a grant, so injection is refused there', async () => {
  // The first assertion is the reason the second one exists, pinned so it cannot drift silently.
  // authorizeOperation's read-only branch returns before grantRequired is ever read, which is
  // correct for inspection but means `secret.use` is not a gate in READ-ONLY. The broker therefore
  // refuses to inject under that profile rather than relying on a check that does not run.
  const readOnly: AccessState = { ...stateWith([]), mode: 'read-only', grants: [] };
  const decision = authorizeOperation(readOnly, actor, 'dex.process.run', 'read-only', Date.now(), { command: 'ps ewwaux', secrets: ['token-a'] });
  assert.equal(decision.allowed, true, 'if this ever becomes false, revisit whether the refusal below is still the right shape');
  assert.equal(readOnly.grants.length, 0, 'the client holds no capability grant at all, let alone secret.use');

  await withStateDir('secret-readonly', async dir => {
    await setSecret(NODE, 'token-a', 'TOKEN_A', VALUE, dir);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-secret-ro-'));
    try {
      // `ps ewwaux` prints a process's own environment and is on the read-only allowlist, so this is
      // a reachable path today rather than a hypothetical one. It must not run at all.
      await assert.rejects(
        nativeCall(NODE, 'dex.process.run', { command: 'ps ewwaux', cwd, secrets: ['token-a'] }, [cwd], 'read-only'),
        /read-only profile does not inject stored secrets/
      );
      // The injection primitive refuses on its own account, not only through the dispatcher above.
      // `ps ewwaux` prints the calling process's own environment, so before this guard existed the
      // variable really was placed where an allowlisted read-only program could read it back; only
      // output scrubbing stood in the way, and scrubbing is not a boundary.
      await assert.rejects(
        nativeProcess('ps ewwaux', cwd, 'read-only', 15_000, [cwd], await resolveSecrets(NODE, ['token-a'], dir)),
        /read-only profile does not inject stored secrets/
      );

      // And the same command without a secret is still the ordinary read-only inspection it was.
      const plain = await nativeCall(NODE, 'dex.process.run', { command: 'ps ewwaux', cwd }, [cwd], 'read-only') as { stdout: string };
      assert.ok(!plain.stdout.includes(VALUE), 'nothing was injected, so nothing can be read back');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test('an operation that cannot inject a secret refuses the request instead of dropping the alias', async () => {
  // dex.compat.call nests its arguments, and requiredCapabilities already demands secret.use for it.
  // Nothing on that path resolves an alias, so without this refusal the owner would authorize a
  // credential-bearing call and the adapter would receive a credential-free one, silently.
  const compat = { tool: 'start_process', arguments: { command: 'deploy', secrets: ['token-a'] } };
  assert.ok(requiredCapabilities('dc.call', compat).includes('secret.use'));
  assert.match(String(secretInjectionRefusal('dc.call', 'development', compat)), /cannot inject a stored secret/);
  assert.match(String(secretInjectionRefusal('dex.file.write', 'development', { path: '/tmp/x', secrets: ['token-a'] })), /cannot inject a stored secret/);
  assert.match(String(secretInjectionRefusal('dex.process.run', 'read-only', { secrets: ['token-a'] })), /read-only profile does not inject/);
  assert.match(String(secretInjectionRefusal('dex.process.run', 'workspace-safe', { secrets: ['token-a'] })), /workspace-safe profile does not inject/);

  // The permitted case, and the untouched case.
  assert.equal(secretInjectionRefusal('dex.process.run', 'development', { secrets: ['token-a'] }), null);
  assert.equal(secretInjectionRefusal('dc.call', 'development', compat.arguments.secrets ? { tool: 'start_process', arguments: { command: 'deploy' } } : {}), null);
  assert.equal(secretInjectionRefusal('dex.file.write', 'development', { path: '/tmp/x' }), null);

  // Malformed input is refused rather than treated as naming nothing.
  assert.match(String(secretInjectionRefusal('dex.file.write', 'development', { secrets: 'token-a' })), /cannot inject/);

  await withStateDir('secret-compat', async dir => {
    await setSecret(NODE, 'token-a', 'TOKEN_A', VALUE, dir);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-secret-compat-'));
    try {
      await assert.rejects(
        nativeCall(NODE, 'dex.file.write', { path: path.join(cwd, 'out.txt'), text: 'x', secrets: ['token-a'] }, [cwd], 'development'),
        /cannot inject a stored secret/
      );
      await fs.access(path.join(cwd, 'out.txt')).then(
        () => assert.fail('the refused write must not have happened'),
        () => undefined
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
