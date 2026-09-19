export type InvariantEvidenceClass = 'live-runtime' | 'regression' | 'mixed' | 'external';

export type ReleaseInvariant = {
  id: string;
  capability: string;
  evidenceClass: InvariantEvidenceClass;
};

export const DEX_INVARIANT_SCHEMA_VERSION = 1;

/**
 * Machine-consumable index of DEX//REACH release-blocking invariants.
 * docs/INVARIANTS.md remains the human-readable proof contract; tests require the two ID sets to match.
 */
export const DEX_RELEASE_INVARIANTS: readonly ReleaseInvariant[] = [
  { id: 'DEX-INV-001', capability: 'Explicit machine selection', evidenceClass: 'mixed' },
  { id: 'DEX-INV-002', capability: 'Node-local owner authority', evidenceClass: 'mixed' },
  { id: 'DEX-INV-003', capability: 'Fail-closed policy', evidenceClass: 'mixed' },
  { id: 'DEX-INV-004', capability: 'Filesystem scope', evidenceClass: 'mixed' },
  { id: 'DEX-INV-005', capability: 'Compatibility configuration stays node-owned', evidenceClass: 'mixed' },
  { id: 'DEX-INV-006', capability: 'READ-ONLY is shell-free', evidenceClass: 'mixed' },
  { id: 'DEX-INV-007', capability: 'ON/full-local limits are represented honestly', evidenceClass: 'mixed' },
  { id: 'DEX-INV-008', capability: 'Process children do not inherit credentials', evidenceClass: 'mixed' },
  { id: 'DEX-INV-009', capability: 'Remote transport protects credentials', evidenceClass: 'regression' },
  { id: 'DEX-INV-010', capability: 'Exact plan executes at most once', evidenceClass: 'mixed' },
  { id: 'DEX-INV-011', capability: 'Receipts are signed and linear', evidenceClass: 'mixed' },
  { id: 'DEX-INV-012', capability: 'Concurrent owner/state writes do not lose authority', evidenceClass: 'regression' },
  { id: 'DEX-INV-013', capability: 'Credentials are independent and revocable', evidenceClass: 'mixed' },
  { id: 'DEX-INV-014', capability: 'Public source grants no runtime authority', evidenceClass: 'external' },
  { id: 'DEX-INV-015', capability: 'Persistent self-update survives transport replacement', evidenceClass: 'live-runtime' },
  { id: 'DEX-INV-016', capability: 'Dock launcher is a recovery/control surface, not an authority escalator', evidenceClass: 'live-runtime' },
  { id: 'DEX-INV-017', capability: 'Public MCP surface is exactly the intended contract', evidenceClass: 'live-runtime' },
  { id: 'DEX-INV-018', capability: 'ADB availability is not faked', evidenceClass: 'live-runtime' },
  { id: 'DEX-INV-019', capability: 'Simulation stays labeled simulation', evidenceClass: 'external' },
  { id: 'DEX-INV-020', capability: 'Planned mutations bind execution identity', evidenceClass: 'mixed' },
  { id: 'DEX-INV-021', capability: 'Live trust reports remain evidence-scoped', evidenceClass: 'mixed' },
  { id: 'DEX-INV-022', capability: 'Machine workload admission grants no execution authority', evidenceClass: 'regression' },
  { id: 'DEX-INV-023', capability: 'Repository mutation ownership is exclusive', evidenceClass: 'regression' },
  { id: 'DEX-INV-024', capability: 'Exhausted machine capacity queues rather than oversubscribes', evidenceClass: 'regression' },
  { id: 'DEX-INV-025', capability: 'Stale coordination state is reclaimed without terminating processes', evidenceClass: 'regression' },
  { id: 'DEX-INV-026', capability: 'Coordination metadata carries no prompts, transcripts or credentials', evidenceClass: 'regression' },
  { id: 'DEX-INV-027', capability: 'Causal evidence links stages without exporting content', evidenceClass: 'regression' },
  { id: 'DEX-INV-028', capability: 'workspace-safe narrows execution and is narrowed by owner authority', evidenceClass: 'regression' },
  { id: 'DEX-INV-029', capability: 'Rolling execution budgets only narrow authority', evidenceClass: 'regression' },
  { id: 'DEX-INV-030', capability: 'Capability requests never grant authority', evidenceClass: 'regression' },
  { id: 'DEX-INV-031', capability: 'Policy assertions and append-only policy history', evidenceClass: 'regression' },
  { id: 'DEX-INV-032', capability: 'Node transport authentication is a separate cryptographic domain from receipt signing', evidenceClass: 'regression' }
] as const;

export function invariantManifest() {
  return {
    schemaVersion: DEX_INVARIANT_SCHEMA_VERSION,
    releaseBlocking: true,
    count: DEX_RELEASE_INVARIANTS.length,
    entries: DEX_RELEASE_INVARIANTS.map(entry => ({ ...entry }))
  };
}
