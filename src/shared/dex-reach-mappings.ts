import { REACH_MAPPING_SCHEMA, REACH_MAPPING_VERSION, type ReachMappingTable } from './dex-command-router.js';

/**
 * The authoritative REACH mappings for DEX commands: which canonical command may invoke which REACH
 * operation, with its safety class, data class and input origin.
 *
 * This table is deliberately EMPTY, and every canonical DEX command is therefore unroutable from REACH.
 * As of the DEX manifest 1.0.0 read for this change (westkitty/DEX packages/router/src/manifest.ts), DEX
 * declares no REACH operation for any command, and no accepted DEX or REACH decision grants one. A mapping
 * added here must cite the accepted document that grants it in `authority`. It must never be inferred from a
 * command name, scope or workflow id.
 *
 * Missing contract, precisely: DEX ADR-0013 does not define `invokesReach`, `reachOperation`, a REACH safety
 * class, a data class or an input origin per command. Until DEX or a REACH ADR does, this stays empty.
 */
export const REACH_AUTHORITATIVE_MAPPINGS: ReachMappingTable = {
  schema: REACH_MAPPING_SCHEMA,
  version: REACH_MAPPING_VERSION,
  mappings: []
};
