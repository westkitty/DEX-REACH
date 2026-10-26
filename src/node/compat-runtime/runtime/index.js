#!/usr/bin/env node
import './bootstrap.js';
import { FilteredStdioServerTransport } from './custom-stdio.js';
import { server, beginShutdown } from './server.js';
import { configManager } from './config-manager.js';
import { terminalManager } from './terminal-manager.js';
import { searchManager } from './search-manager.js';
import {shutdownVirtualSessions} from './tools/improved-process-tools.js';

await configManager.loadConfig();
const allowedRoots = JSON.parse(process.env.DEX_COMPAT_ALLOWED_ROOTS || 'null');
if (!Array.isArray(allowedRoots) || allowedRoots.length === 0 || allowedRoots.some(root => typeof root !== 'string' || !root.startsWith('/'))) {
    throw new Error('DEX compatibility backend requires explicit absolute allowed roots');
}
await configManager.setValue('allowedDirectories', allowedRoots);
await configManager.setValue('telemetryEnabled', false);
const configured = await configManager.getConfig();
if (configured.telemetryEnabled !== false || JSON.stringify(configured.allowedDirectories) !== JSON.stringify(allowedRoots)) {
    throw new Error('DEX compatibility backend configuration did not match owner policy');
}
const transport = new FilteredStdioServerTransport();
global.mcpTransport = transport;
let closing = false;
async function shutdown() {
    if (closing) return;
    closing = true;
    beginShutdown();
    await Promise.all([terminalManager.terminateAllSessions(1000), searchManager.shutdown(1000), shutdownVirtualSessions()]).catch(() => undefined);
    await server.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.stdin.once('end', shutdown);
await server.connect(transport);
