import { DEX_RELEASE_INVARIANTS, invariantManifest } from '../src/shared/invariants.js';

const checkOnly = process.argv.includes('--check');
const ids = DEX_RELEASE_INVARIANTS.map(entry => entry.id);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error(`duplicate invariant IDs: ${[...new Set(duplicates)].join(', ')}`);
if (!ids.every(id => /^DEX-INV-\d{3}$/.test(id))) throw new Error('invariant IDs must use DEX-INV-NNN format');

if (checkOnly) {
  console.log(`DEX//REACH invariant manifest PASS (${ids.length} release-blocking invariants)`);
} else {
  console.log(JSON.stringify(invariantManifest(), null, 2));
}
