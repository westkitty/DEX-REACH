import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { verifyRuntimeRelease } from './runtime-release.js';

export type RuntimeRollbackService = { label: string; target: string };

type SavedFile = {
  path: string;
  previousBase64: string;
  previousSha256: string;
  candidateSha256: string;
};

type SavedOptionalFile = {
  path: string;
  previousBase64: string | null;
  previousSha256: string | null;
  candidateSha256: string;
};

export type RuntimeRollbackSnapshot = {
  schemaVersion: 1;
  candidateReleaseId: string;
  candidateReleaseSha256: string;
  previousReleaseId: string;
  preparedAt: string;
  previousReleaseSha256: string;
  services: Array<{ label: string; file: SavedFile }>;
  workerConfig: SavedOptionalFile;
};

const REQUIRED_LABELS = [
  'com.stinkyweasel.dex-reach.coordinator',
  'com.stinkyweasel.dex-reach.worker',
  'com.stinkyweasel.dex-reach.gateway',
  'com.stinkyweasel.dex-reach.node',
  'com.stinkyweasel.dex-reach.oauth-canary'
].sort();

function safeReleaseId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(value)) throw new Error('invalid runtime release id');
  return value;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Content-and-mode fingerprint for an immutable runtime tree; symlinks are recorded, never followed. */
export async function runtimeTreeSha256(root: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const rootStat = await fs.lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('runtime root must be a real directory');
  const hash = crypto.createHash('sha256');
  const visit = async (directory: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(directory);
    entries.sort();
    for (const name of entries) {
      const file = path.join(directory, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stat = await fs.lstat(file);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        hash.update(`link\0${rel}\0${mode}\0${await fs.readlink(file)}\n`);
      } else if (stat.isDirectory()) {
        hash.update(`dir\0${rel}\0${mode}\n`);
        await visit(file, rel);
      } else if (stat.isFile()) {
        hash.update(`file\0${rel}\0${mode}\0${await hashFile(file)}\n`);
      } else {
        throw new Error(`unsupported runtime entry type: ${rel}`);
      }
    }
  };
  hash.update(`root\0${rootStat.mode & 0o777}\n`);
  await visit(absoluteRoot, '');
  return hash.digest('hex');
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function releaseIdFromPlist(text: string, label: string, expectedRoot?: string): string {
  const encodedLabel = text.match(/<key>Label<\/key><string>([^<]+)<\/string>/)?.[1];
  if (!encodedLabel || decodeXml(encodedLabel) !== label) throw new Error(`LaunchAgent label mismatch: ${label}`);
  const workingDirectory = text.match(/<key>WorkingDirectory<\/key><string>([^<]+)<\/string>/)?.[1];
  if (!workingDirectory) throw new Error(`LaunchAgent has no working directory: ${label}`);
  const resolved = path.resolve(decodeXml(workingDirectory));
  if (expectedRoot && resolved !== path.resolve(expectedRoot)) throw new Error(`LaunchAgent runtime root mismatch: ${label}`);
  const match = resolved.match(/(?:^|\/)runtime\/releases\/([^/]+)$/);
  if (!match) throw new Error(`LaunchAgent does not point to an immutable runtime release: ${label}`);
  const matchedId = match[1];
  if (!matchedId) throw new Error(`LaunchAgent has an invalid runtime release path: ${label}`);
  const id = safeReleaseId(matchedId);
  const references = [...text.matchAll(/\/runtime\/releases\/([^/<]+)(?=\/|<)/g)].map(item => {
    if (!item[1]) throw new Error(`LaunchAgent has an invalid runtime path reference: ${label}`);
    return safeReleaseId(item[1]);
  });
  if (references.length === 0 || references.some(reference => reference !== id)) {
    throw new Error(`LaunchAgent contains mixed runtime release paths: ${label}`);
  }
  return id;
}

async function atomicWrite(file: string, contents: Buffer, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.rollback-${crypto.randomUUID()}`;
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r').catch(() => undefined);
    if (directory) {
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readOptional(file: string): Promise<Buffer | null> {
  try { return await fs.readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Capture the exact active LaunchAgents and generated worker config before activation mutates them. */
export async function prepareRuntimeRollbackSnapshot(input: {
  stateDir: string;
  agentsDir: string;
  candidateReleaseId: string;
  candidateReleaseRoot: string;
  services: RuntimeRollbackService[];
  candidatePlists: Record<string, string>;
  workerConfigPath: string;
  candidateWorkerConfig: string;
}): Promise<string | null> {
  const candidateId = safeReleaseId(input.candidateReleaseId);
  const labels = input.services.map(service => service.label).sort();
  if (labels.length !== REQUIRED_LABELS.length || labels.some((label, index) => label !== REQUIRED_LABELS[index])) {
    throw new Error('rollback snapshot requires the exact five DEX LaunchAgents');
  }
  if (path.resolve(input.candidateReleaseRoot) !== path.resolve(input.stateDir, 'runtime', 'releases', candidateId)) {
    throw new Error('candidate runtime root does not match candidate release id');
  }
  await verifyRuntimeRelease(input.candidateReleaseRoot);
  const candidateReleaseSha256 = await runtimeTreeSha256(input.candidateReleaseRoot);

  const previous: Array<{ label: string; target: string; bytes: Buffer; candidateBytes: Buffer }> = [];
  for (const service of input.services) {
    const target = path.resolve(service.target);
    if (path.dirname(target) !== path.resolve(input.agentsDir)) throw new Error(`LaunchAgent path outside expected directory: ${service.label}`);
    const candidateText = input.candidatePlists[service.label];
    if (!candidateText || releaseIdFromPlist(candidateText, service.label, input.candidateReleaseRoot) !== candidateId) {
      throw new Error(`candidate LaunchAgent does not match candidate release: ${service.label}`);
    }
    previous.push({ label: service.label, target, bytes: await fs.readFile(target), candidateBytes: Buffer.from(candidateText) });
  }

  const oldIds = previous.map(service => releaseIdFromPlist(service.bytes.toString('utf8'), service.label));
  const previousId = oldIds[0];
  if (!previousId || oldIds.some(id => id !== previousId)) throw new Error('active LaunchAgents do not share one runtime release');
  const previousReleaseId = safeReleaseId(previousId);
  if (previousReleaseId === candidateId) throw new Error('candidate and previous runtime release ids are identical');
  const previousRoot = path.resolve(input.stateDir, 'runtime', 'releases', previousReleaseId);
  for (const service of previous) releaseIdFromPlist(service.bytes.toString('utf8'), service.label, previousRoot);
  await verifyRuntimeRelease(previousRoot);
  const previousReleaseSha256 = await runtimeTreeSha256(previousRoot);

  const configPath = path.resolve(input.workerConfigPath);
  const normalizedStateDir = path.resolve(input.stateDir);
  if (!configPath.startsWith(`${normalizedStateDir}${path.sep}`)) throw new Error('worker configuration path must be inside the DEX state directory');
  const candidateConfig = Buffer.from(input.candidateWorkerConfig);
  const oldConfig = await readOptional(configPath);
  const snapshot: RuntimeRollbackSnapshot = {
    schemaVersion: 1,
    candidateReleaseId: candidateId,
    candidateReleaseSha256,
    previousReleaseId,
    preparedAt: new Date().toISOString(),
    previousReleaseSha256,
    services: previous.map(service => ({
      label: service.label,
      file: {
        path: service.target,
        previousBase64: service.bytes.toString('base64'),
        previousSha256: sha256(service.bytes),
        candidateSha256: sha256(service.candidateBytes)
      }
    })),
    workerConfig: {
      path: configPath,
      previousBase64: oldConfig?.toString('base64') ?? null,
      previousSha256: oldConfig ? sha256(oldConfig) : null,
      candidateSha256: sha256(candidateConfig)
    }
  };
  const snapshotDirectory = path.join(input.stateDir, 'runtime', 'rollback', candidateId);
  await fs.mkdir(path.dirname(snapshotDirectory), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(snapshotDirectory), 0o700);
  await fs.mkdir(snapshotDirectory, { mode: 0o700 });
  await fs.chmod(snapshotDirectory, 0o700);
  const snapshotPath = path.join(snapshotDirectory, 'snapshot.json');
  await atomicWrite(snapshotPath, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`), 0o600);
  const parent = await fs.open(path.dirname(snapshotDirectory), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  return snapshotPath;
}

function validateSnapshot(value: unknown): RuntimeRollbackSnapshot {
  const snapshot = value as RuntimeRollbackSnapshot;
  if (!snapshot || snapshot.schemaVersion !== 1) throw new Error('unsupported rollback snapshot schema');
  safeReleaseId(snapshot.candidateReleaseId);
  safeReleaseId(snapshot.previousReleaseId);
  if (snapshot.candidateReleaseId === snapshot.previousReleaseId) throw new Error('rollback snapshot has identical release ids');
  if (!/^[a-f0-9]{64}$/.test(snapshot.candidateReleaseSha256)) throw new Error('invalid candidate runtime integrity hash');
  if (!/^[a-f0-9]{64}$/.test(snapshot.previousReleaseSha256)) throw new Error('invalid previous runtime integrity hash');
  if (!Array.isArray(snapshot.services) || snapshot.services.map(item => item.label).sort().join('\n') !== REQUIRED_LABELS.join('\n')) {
    throw new Error('rollback snapshot service inventory mismatch');
  }
  for (const { label, file } of snapshot.services) {
    if (!file || !/^[a-f0-9]{64}$/.test(file.previousSha256) || !/^[a-f0-9]{64}$/.test(file.candidateSha256)) throw new Error(`invalid saved LaunchAgent metadata: ${label}`);
    const bytes = Buffer.from(file.previousBase64, 'base64');
    if (sha256(bytes) !== file.previousSha256 || releaseIdFromPlist(bytes.toString('utf8'), label) !== snapshot.previousReleaseId) {
      throw new Error(`saved LaunchAgent integrity mismatch: ${label}`);
    }
  }
  if (!snapshot.workerConfig || !/^[a-f0-9]{64}$/.test(snapshot.workerConfig.candidateSha256)) throw new Error('invalid saved worker configuration metadata');
  if (snapshot.workerConfig.previousBase64 === null) {
    if (snapshot.workerConfig.previousSha256 !== null) throw new Error('invalid absent worker configuration metadata');
  } else {
    const bytes = Buffer.from(snapshot.workerConfig.previousBase64, 'base64');
    if (!snapshot.workerConfig.previousSha256 || sha256(bytes) !== snapshot.workerConfig.previousSha256) throw new Error('saved worker configuration integrity mismatch');
  }
  return snapshot;
}

export type RestoreRuntimeRollbackInput = {
  snapshotPath: string;
  stateDir: string;
  agentsDir: string;
  workerConfigPath: string;
  services: RuntimeRollbackService[];
  candidateReleaseId?: string;
};

type RestorePlan = {
  snapshot: RuntimeRollbackSnapshot;
  restoreFiles: Array<{ target: string; bytes: Buffer; mode: number }>;
  configPath: string;
};

async function preflightRestore(input: RestoreRuntimeRollbackInput): Promise<RestorePlan> {
  const snapshot = validateSnapshot(JSON.parse(await fs.readFile(input.snapshotPath, 'utf8')) as unknown);
  if (input.candidateReleaseId && safeReleaseId(input.candidateReleaseId) !== snapshot.candidateReleaseId) {
    throw new Error('rollback snapshot candidate revision mismatch');
  }
  const expectedSnapshotPath = path.resolve(input.stateDir, 'runtime', 'rollback', snapshot.candidateReleaseId, 'snapshot.json');
  if (path.resolve(input.snapshotPath) !== expectedSnapshotPath) throw new Error('rollback snapshot path does not match its candidate revision');
  const labels = input.services.map(service => service.label).sort();
  if (labels.join('\n') !== REQUIRED_LABELS.join('\n')) throw new Error('rollback requires the exact five DEX LaunchAgents');
  const previousRoot = path.resolve(input.stateDir, 'runtime', 'releases', snapshot.previousReleaseId);
  await verifyRuntimeRelease(previousRoot);
  if (await runtimeTreeSha256(previousRoot) !== snapshot.previousReleaseSha256) throw new Error('previous runtime integrity check failed');
  for (const { label, file } of snapshot.services) releaseIdFromPlist(Buffer.from(file.previousBase64, 'base64').toString('utf8'), label, previousRoot);

  const savedByLabel = new Map(snapshot.services.map(item => [item.label, item.file]));
  const restoreFiles: Array<{ target: string; bytes: Buffer; mode: number }> = [];
  for (const service of input.services) {
    const target = path.resolve(service.target);
    if (path.dirname(target) !== path.resolve(input.agentsDir)) throw new Error(`LaunchAgent path outside expected directory: ${service.label}`);
    const saved = savedByLabel.get(service.label);
    if (!saved || path.resolve(saved.path) !== target) throw new Error(`rollback LaunchAgent target mismatch: ${service.label}`);
    const current = await fs.readFile(target);
    const currentHash = sha256(current);
    if (currentHash !== saved.previousSha256 && currentHash !== saved.candidateSha256) throw new Error(`ambiguous LaunchAgent state; refusing rollback: ${service.label}`);
    restoreFiles.push({ target, bytes: Buffer.from(saved.previousBase64, 'base64'), mode: 0o600 });
  }

  const configPath = path.resolve(input.workerConfigPath);
  if (configPath !== path.resolve(snapshot.workerConfig.path) || !configPath.startsWith(`${path.resolve(input.stateDir)}${path.sep}`)) {
    throw new Error('worker configuration path mismatch');
  }
  const currentConfig = await readOptional(configPath);
  const currentConfigHash = currentConfig ? sha256(currentConfig) : null;
  if (currentConfigHash !== snapshot.workerConfig.previousSha256 && currentConfigHash !== snapshot.workerConfig.candidateSha256) {
    throw new Error('ambiguous worker configuration state; refusing rollback');
  }
  return { snapshot, restoreFiles, configPath };
}

/** Check a rollback transaction without writing any active files. */
export async function validateRuntimeRollbackSnapshot(input: RestoreRuntimeRollbackInput): Promise<string> {
  return (await preflightRestore(input)).snapshot.previousReleaseId;
}

/** Restore only when every current file belongs to the recorded old or candidate transaction. Repeatable after partial restore. */
export async function restoreRuntimeRollbackSnapshot(input: RestoreRuntimeRollbackInput): Promise<string> {
  const { snapshot, restoreFiles, configPath } = await preflightRestore(input);
  // All files and the retained runtime are validated before the first restoration write.
  for (const file of restoreFiles) await atomicWrite(file.target, file.bytes, file.mode);
  if (snapshot.workerConfig.previousBase64 === null) await fs.rm(configPath, { force: true });
  else await atomicWrite(configPath, Buffer.from(snapshot.workerConfig.previousBase64, 'base64'), 0o600);
  return snapshot.previousReleaseId;
}
