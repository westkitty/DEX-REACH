import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const command = process.execPath;
const args = ['node_modules/@wonderwhy-er/desktop-commander/dist/index.js', '--no-onboarding'];
const transport = new StdioClientTransport({ command, args, stderr: 'pipe' });
const client = new Client({ name: 'dex-reach-probe', version: '0.2.0' });
await client.connect(transport);
const tools = await client.listTools();
console.log(JSON.stringify({ count: tools.tools.length, names: tools.tools.map(t => t.name) }, null, 2));
await client.close();
