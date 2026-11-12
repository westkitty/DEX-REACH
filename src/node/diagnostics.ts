import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Fixed, passive macOS inspections. No arbitrary executable, path or command
 * parameters can enter this operation; it is intentionally NOT a shell tool.
 */
export const MAC_DIAGNOSTIC_KINDS = [
  'icloud-settings', 'icloud-paths', 'file-providers',
  'spotlight-status', 'process-snapshot'
] as const;
export type MacDiagnosticKind = (typeof MAC_DIAGNOSTIC_KINDS)[number];

export function parseCloudServiceFlags(raw: string): {
  mobileDocumentsEnabled: boolean | null;
  cloudDesktopActive: boolean | null;
} {
  const serviceBlocks = raw.match(/\{[^{}]*\}/g) ?? [];
  const service = (name: string): string | undefined => serviceBlocks.find(block =>
    block.includes('Name = ' + name + ';') || block.includes('Name = "' + name + '";')
  );
  const documents = service('MOBILE_DOCUMENTS');
  const desktop = service('CLOUDDESKTOP');
  const enabled = documents ? /\bEnabled = ([01]);/.exec(documents) : null;
  const status = desktop ? /\bstatus = ([a-zA-Z]+);/.exec(desktop) : null;
  return {
    mobileDocumentsEnabled: enabled ? enabled[1] === '1' : null,
    cloudDesktopActive: status ? status[1] === 'active' : null
  };
}

async function fixedRead(executable: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(executable, args, {
    timeout: 4000,
    maxBuffer: 128 * 1024,
    env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' }
  });
  return stdout;
}

export async function inspectMacDiagnostic(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Check the entire input, not just its discriminator. No argument laundering.
  if (Object.keys(args).length !== 1 || !Object.hasOwn(args, 'kind')) {
    throw new Error('diagnostic requires exactly one kind and no additional arguments');
  }
  const kind = args.kind;
  if (typeof kind !== 'string' || !(MAC_DIAGNOSTIC_KINDS as readonly string[]).includes(kind)) {
    throw new Error('unsupported diagnostic kind');
  }
  if (process.platform !== 'darwin') return { kind, status: 'unsupported-platform' };

  try {
    if (kind === 'icloud-settings') {
      const raw = await fixedRead('/usr/bin/defaults', ['read', 'MobileMeAccounts']);
      // Never return raw account preferences, Apple IDs, credentials or tokens.
      return { kind, status: 'ok', ...parseCloudServiceFlags(raw) };
    }
    if (kind === 'file-providers') {
      const directory = path.join(os.homedir(), 'Library', 'CloudStorage');
      const names = await fs.readdir(directory);
      const activeLabels = names.filter(name => !name.startsWith('.')).map(name => {
        if (name.startsWith('GoogleDrive-')) return 'GoogleDrive';
        if (name.startsWith('Dropbox')) return 'Dropbox';
        if (name.startsWith('OneDrive')) return 'OneDrive';
        if (name.startsWith('Box-')) return 'Box';
        return 'Other';
      });
      return { kind, status: 'ok', cloudStorageEntryCount: activeLabels.length,
        cloudStorageProviderKinds: [...new Set(activeLabels)].sort(),
        note: 'CloudStorage directory entries do not prove live provider sync' };
    }
    if (kind === 'spotlight-status') {
      const stdout = await fixedRead('/usr/bin/mdutil', ['-s', '/']);
      return { kind, status: 'ok', rootVolumeIndexingEnabled: /Indexing enabled/.test(stdout),
        rootVolumeIndexingDisabled: /Indexing disabled/.test(stdout) };
    }
    if (kind === 'icloud-paths') {
      const home = os.homedir();
      const targets = [
        ['Desktop', path.join(home, 'Desktop')],
        ['Documents', path.join(home, 'Documents')],
        ['CloudDocs', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')]
      ] as const;
      const paths = await Promise.all(targets.map(async ([label, location]) => {
        try {
          const stat = await fs.lstat(location);
          const symlink = stat.isSymbolicLink();
          return { label, exists: true, directory: stat.isDirectory(), symlink,
            ...(symlink ? { target: (await fs.readlink(location)).slice(0, 256) } : {}) };
        } catch (error) {
          return { label, exists: false,
            reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'unavailable' };
        }
      }));
      return { kind, status: 'ok', paths };
    }
    // One fixed process listing, not a user-provided ps invocation.
    const stdout = await fixedRead('/bin/ps', ['-axo', 'pid,%cpu,comm']);
    const processes = stdout.split('\n').slice(1).map(line => {
      const match = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
      if (!match) return null;
      const name = path.basename(match[3]!);
      return /^(?:fileproviderd|bird|cloudd|mds|mds_stores)$/.test(name)
        ? { pid: Number(match[1]), cpuPercentOfCore: Number(match[2]), name } : null;
    }).filter(item => item !== null).slice(0, 25);
    return { kind, status: 'ok', processes };
  } catch {
    return { kind, status: 'unavailable' };
  }
}
