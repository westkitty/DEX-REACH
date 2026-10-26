// DEX-maintained protocol dispatcher. MIT-derived operation handlers retain their notices.
// DEX authorization remains in the node executor; this is a second surface boundary.
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {checkReadBudget,checkResultBudget} from './utils/resource-limits.js';
import { compatibilityArgumentViolation } from './utils/argument-limits.js';
import * as handlers from './handlers/index.js';
import { getConfig } from './tools/config.js';
import { getUsageStats } from './tools/usage.js';
import { usageTracker } from './utils/usageTracker.js';

const require = createRequire(import.meta.url);
const contract = require('./fixtures/desktop-commander-0.2.52-remote-contract.json');
const operations = Object.freeze({
 get_config: getConfig, get_usage_stats: getUsageStats,
 read_file: handlers.handleReadFile, read_multiple_files: handlers.handleReadMultipleFiles,
 write_file: handlers.handleWriteFile, write_pdf: handlers.handleWritePdf,
 create_directory: handlers.handleCreateDirectory, list_directory: handlers.handleListDirectory,
 move_file: handlers.handleMoveFile, get_file_info: handlers.handleGetFileInfo,
 edit_block: handlers.handleEditBlock, start_search: handlers.handleStartSearch,
 get_more_search_results: handlers.handleGetMoreSearchResults, stop_search: handlers.handleStopSearch,
 list_searches: handlers.handleListSearches, start_process: handlers.handleStartProcess,
 read_process_output: handlers.handleReadProcessOutput, interact_with_process: handlers.handleInteractWithProcess,
 force_terminate: handlers.handleForceTerminate, list_sessions: handlers.handleListSessions,
 list_processes: handlers.handleListProcesses, kill_process: handlers.handleKillProcess
});
if (Object.keys(operations).length !== 22 || contract.tools.length !== 22 ||
    contract.tools.some(tool => typeof operations[tool.name] !== 'function')) {
 throw new Error('DEX compatibility operation inventory does not match frozen contract');
}
export const currentClient = Object.freeze({ name: 'dex-reach-node', version: 'candidate' });
export const currentCallIsRemote = false;
export const currentRemoteClient = null;
export function flushDeferredMessages() {}
export const server = new Server({name:'dex-reach-native-compat',version:'0.1.0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
 tools: contract.tools.map(tool => ({name:tool.name, description:'DEX//REACH compatibility operation: '+tool.name, inputSchema:tool.inputSchema}))
}));
let accepting = true;
export function beginShutdown() { accepting = false; }
const failure = message => ({content:[{type:'text',text:'Error: '+message}],isError:true});
server.setRequestHandler(CallToolRequestSchema, async request => {
 const { name, arguments: supplied } = request.params;
 if (!accepting) return failure('DEX compatibility backend closing');
 // Test membership before looking up the function: inherited Object properties are not tools.
 if (!Object.hasOwn(operations,name)) return failure('Unknown tool: '+name);
 const args = supplied ?? {};
 const violation = compatibilityArgumentViolation(args);
 if (violation) return failure(violation);
 let result;
 try { await checkReadBudget(name,args); result = checkResultBudget(await operations[name](args),name); }
 catch (error) { result = failure(error instanceof Error ? error.message : String(error)); }
 // Counts only. Never persist arguments, command text, file contents or tool results here.
 try {
  if (result.isError) await usageTracker.trackFailure(name);
  else await usageTracker.trackSuccess(name);
 } catch { /* DEX activity reporting is owned by the node, not by these counters. */ }
 return result;
});
