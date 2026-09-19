import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DEX_REACH_VERSION } from '../src/shared/version.js';

const command = process.execPath;
const args = ['node_modules/@wonderwhy-er/desktop-commander/dist/index.js', '--no-onboarding'];
const transport = new StdioClientTransport({ command, args, stderr: 'pipe' });
const client = new Client({ name: 'dex-reach-probe', version: DEX_REACH_VERSION });
await client.connect(transport);
const tools = await client.listTools();
console.log(JSON.stringify({ count: tools.tools.length, names: tools.tools.map(t => t.name) }, null, 2));
await client.close();
