import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRoutableManifest, type LoadedManifest, type RouterNodeView, type RouterRefusal } from '../src/shared/dex-command-router.js';
import assert from 'node:assert/strict';

// SYNTHETIC fixtures in the real DEX command-manifest shape (DEX `DexCommandManifestEntry`, manifest 1.0.0).
// The command names are `DEX//FIXTURE_*`: they are not the DEX roster, and nothing here proves DEX behaviour.
// The real roster is in dex-roster-snapshot-v1.json (owner-approved; identity and classification only).

const dir = path.resolve(import.meta.dirname, 'fixtures/dex-router');
export const canonicalRaw = JSON.parse(await fs.readFile(path.join(dir, 'canonical-manifest.synthetic-v1.json'), 'utf8')) as Record<string, any>;
export const mappingsRaw = JSON.parse(await fs.readFile(path.join(dir, 'reach-mappings.synthetic-v1.json'), 'utf8')) as Record<string, any>;

export const cloneCanonical = (): Record<string, any> => structuredClone(canonicalRaw);
export const cloneMappings = (): Record<string, any> => structuredClone(mappingsRaw);

export function loadFixture(canonical: unknown = canonicalRaw, mappings: unknown = mappingsRaw): LoadedManifest {
  const result = loadRoutableManifest({ canonical, mappings });
  if (!result.ok) throw new Error(`fixture failed to load: ${result.code}: ${result.message}`);
  return result.manifest;
}

export function refusalOf(value: unknown): RouterRefusal {
  assert.equal((value as { ok: boolean }).ok, false, 'expected a refusal');
  return value as RouterRefusal;
}

export const capableAdapters = { session: '1.0.0', dropzone: '1.0.0', pair: '1.0.0', witness: '1.0.0', remix: '1.0.0', capsule: '1.0.0' } as const;

export function node(overrides: Partial<RouterNodeView> & { nodeId: string }): RouterNodeView {
  return {
    enrolled: true,
    online: true,
    capabilities: { dex_command_router: true },
    productAdapters: { ...capableAdapters },
    ...overrides
  };
}
