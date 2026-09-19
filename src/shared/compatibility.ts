import { remoteBlockedCompatibilityTools } from './operations.js';

/**
 * Compatibility tools withheld from remote clients: safety configuration, local call history, and
 * vendor feedback/onboarding surfaces. Derived from the operation catalog so the block list and the
 * risk classification cannot drift apart.
 */
export const REMOTE_BLOCKED_COMPATIBILITY_TOOLS = remoteBlockedCompatibilityTools();
